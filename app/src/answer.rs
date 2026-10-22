//! An answer as the page draws it, in order: OXR writes Markdown, with tables as HTML
//! (`<table>`, `<tr>`, `<td>` or `<th>` with `colspan` and `rowspan`), code in fenced blocks and
//! formulas in LaTeX between dollar signs, a displayed one on a line of its own. A table's cells
//! are read as text, never as markup: the page never injects the model's HTML.

const TABLE_START: &str = "<table";
const TABLE_END: &str = "</table>";
const ROW_START: &str = "<tr";
const ROW_END: &str = "</tr>";
/// A cell's opening tag, bare or with attributes (not `<thead>`).
const CELL_STARTS: [&str; 4] = ["<td>", "<td ", "<th>", "<th "];
const FENCE: &str = "```";
/// The delimiters of a displayed formula, the longer first.
const DISPLAY_MATH: [(&str, &str); 3] = [("$$", "$$"), ("\\[", "\\]"), ("$", "$")];

/// A cell the page draws: its text, and the columns and rows it spans.
#[derive(Clone, PartialEq)]
pub(crate) struct Cell {
    pub(crate) column: usize,
    pub(crate) text: String,
    pub(crate) columns: usize,
    pub(crate) rows: usize,
}

#[derive(Clone, PartialEq)]
pub(crate) struct Row {
    pub(crate) index: usize,
    pub(crate) cells: Vec<Cell>,
}

#[derive(Clone, PartialEq)]
pub(crate) enum Kind {
    Text,
    Code,
    /// A displayed formula: its LaTeX, delimiters dropped.
    Formula,
    Table(Vec<Row>),
}

/// A piece of a text block: text as written, or a formula inline (its LaTeX).
#[derive(Clone, PartialEq)]
pub(crate) struct Segment {
    pub(crate) index: usize,
    pub(crate) text: String,
    pub(crate) math: bool,
}

/// One block of the answer: a run of text, a displayed formula, a code block or a table.
#[derive(Clone, PartialEq)]
pub(crate) struct Block {
    pub(crate) index: usize,
    pub(crate) kind: Kind,
    pub(crate) text: String,
}

impl Block {
    pub(crate) fn is_table(&self) -> bool {
        matches!(self.kind, Kind::Table(_))
    }

    pub(crate) fn is_code(&self) -> bool {
        self.kind == Kind::Code
    }

    pub(crate) fn is_formula(&self) -> bool {
        self.kind == Kind::Formula
    }

    pub(crate) fn is_text(&self) -> bool {
        self.kind == Kind::Text
    }

    /// A text block's text and inline formulas, in order.
    pub(crate) fn segments(&self) -> Vec<Segment> {
        let mut segments = Vec::new();
        let mut rest = self.text.as_str();
        while let Some((start, end)) = inline_math(rest) {
            segment(&mut segments, &rest[..start], false);
            segment(&mut segments, &rest[start + 1..end], true);
            rest = &rest[end + 1..];
        }
        segment(&mut segments, rest, false);
        segments
    }

    pub(crate) fn rows(&self) -> Vec<Row> {
        match &self.kind {
            Kind::Table(rows) => rows.clone(),
            Kind::Text | Kind::Code | Kind::Formula => Vec::new(),
        }
    }
}

/// The blocks of an answer: its tables and fenced code apart, the text between them trimmed;
/// a table still being written, or one without cells, stays text.
pub(crate) fn blocks(answer: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut rest = answer;
    while !rest.is_empty() {
        let (before, special, after) = next_special(rest);
        push_text(&mut blocks, before);
        if let Some((kind, text)) = special {
            push(&mut blocks, kind, text);
        }
        rest = after;
    }
    blocks
}

/// A run of text: each line that is a displayed formula a block of its own, the lines between
/// them text blocks.
fn push_text(blocks: &mut Vec<Block>, text: &str) {
    let (mut start, mut at) = (0, 0);
    for line in text.split_inclusive('\n') {
        if let Some(tex) = displayed(line.trim()) {
            push(blocks, Kind::Text, &text[start..at]);
            push(blocks, Kind::Formula, tex);
            start = at + line.len();
        }
        at += line.len();
    }
    push(blocks, Kind::Text, &text[start..]);
}

fn segment(segments: &mut Vec<Segment>, text: &str, math: bool) {
    if text.is_empty() {
        return;
    }
    segments.push(Segment {
        index: segments.len(),
        text: text.into(),
        math,
    });
}

/// The byte offsets of the dollar signs around the first inline formula, by Pandoc's rule: the
/// opening one is followed by a non-space, the closing one preceded by a non-space and not
/// followed by a digit (so that "$5 and $10" stays text). A formula does not span lines.
fn inline_math(text: &str) -> Option<(usize, usize)> {
    let dollars: Vec<usize> = text.match_indices('$').map(|(at, _)| at).collect();
    let after = |at: usize| text[at + 1..].chars().next();
    let before = |at: usize| text[..at].chars().next_back();
    let opens = |at: usize| after(at).is_some_and(|next| !next.is_whitespace() && next != '$');
    let closes = |at: usize| {
        before(at).is_some_and(|previous| !previous.is_whitespace())
            && !after(at).is_some_and(|next| next.is_ascii_digit())
    };
    dollars.iter().enumerate().find_map(|(index, &start)| {
        if !opens(start) {
            return None;
        }
        let end = dollars[index + 1..]
            .iter()
            .copied()
            .find(|&end| end > start + 1 && closes(end))?;
        (!text[start..end].contains('\n')).then_some((start, end))
    })
}

/// The LaTeX of a line that is one displayed formula.
fn displayed(line: &str) -> Option<&str> {
    DISPLAY_MATH.iter().find_map(|(open, close)| {
        let tex = line.strip_prefix(open)?.strip_suffix(close)?;
        let single = !tex.is_empty() && !tex.contains(open);
        single.then_some(tex)
    })
}

fn push(blocks: &mut Vec<Block>, kind: Kind, text: &str) {
    let text = text.trim_matches('\n');
    if text.trim().is_empty() {
        return;
    }
    let index = blocks.len();
    blocks.push(Block {
        index,
        kind,
        text: text.into(),
    });
}

/// The text before the first whole table or code block, that block, and the text after it.
fn next_special(text: &str) -> (&str, Option<(Kind, &str)>, &str) {
    let table = text.find(TABLE_START);
    let fence = text.find(FENCE);
    match (table, fence) {
        (Some(table), Some(fence)) if fence < table => code_at(text, fence),
        (Some(table), _) => table_at(text, table),
        (None, Some(fence)) => code_at(text, fence),
        (None, None) => (text, None, ""),
    }
}

fn table_at(text: &str, at: usize) -> (&str, Option<(Kind, &str)>, &str) {
    let Some(length) = text[at..].find(TABLE_END) else {
        return (text, None, "");
    };
    let end = at + length + TABLE_END.len();
    let html = &text[at..end];
    let rows = rows(html);
    let kind = if rows.is_empty() {
        Kind::Text
    } else {
        Kind::Table(rows)
    };
    (&text[..at], Some((kind, html)), &text[end..])
}

/// A fenced code block, its fences and language dropped; an unclosed one runs to the end.
fn code_at(text: &str, at: usize) -> (&str, Option<(Kind, &str)>, &str) {
    let body_start = text[at + FENCE.len()..]
        .find('\n')
        .map_or(text.len(), |line| at + FENCE.len() + line + 1);
    let body = &text[body_start..];
    let (code, after) = match body.find(FENCE) {
        Some(end) => (&body[..end], &body[end + FENCE.len()..]),
        None => (body, ""),
    };
    (&text[..at], Some((Kind::Code, code)), after)
}

/// The rows of an HTML table, each with its cells' text and spans.
fn rows(html: &str) -> Vec<Row> {
    let mut rows = Vec::new();
    let mut rest = html;
    while let Some(start) = rest.find(ROW_START) {
        let row = &rest[start..];
        let end = row
            .find(ROW_END)
            .map_or(row.len(), |end| end + ROW_END.len());
        let cells = cells(&row[..end]);
        if !cells.is_empty() {
            rows.push(Row {
                index: rows.len(),
                cells,
            });
        }
        rest = &row[end..];
    }
    rows
}

fn cells(row: &str) -> Vec<Cell> {
    let mut cells = Vec::new();
    let mut rest = row;
    while let Some(start) = CELL_STARTS.iter().filter_map(|tag| rest.find(tag)).min() {
        let cell = &rest[start..];
        let Some(open_end) = cell.find('>') else {
            break;
        };
        let tag = &cell[..open_end];
        let content = &cell[open_end + 1..];
        let close = content.find("</t").unwrap_or(content.len());
        cells.push(Cell {
            column: cells.len(),
            text: plain(&content[..close]),
            columns: span(tag, "colspan"),
            rows: span(tag, "rowspan"),
        });
        rest = &content[close..];
        rest = rest.find('>').map_or("", |end| &rest[end + 1..]);
    }
    cells
}

/// The value of a span attribute in an opening tag, 1 when it has none.
fn span(tag: &str, attribute: &str) -> usize {
    let Some(at) = tag.find(attribute) else {
        return 1;
    };
    let value = tag[at + attribute.len()..].trim_start_matches(['=', '"', '\'', ' ']);
    let digits: String = value.chars().take_while(char::is_ascii_digit).collect();
    // A span the model wrote without a number spans one cell, as a browser reads it.
    digits.parse().unwrap_or(1).max(1)
}

/// A cell's text: its inner tags (`<br>`, `<b>` …) dropped, `<br>` as a line break, and the
/// entities HTML escapes decoded.
fn plain(content: &str) -> String {
    let mut text = String::new();
    let mut rest = content;
    while let Some(open) = rest.find('<') {
        text.push_str(&rest[..open]);
        let Some(close) = rest[open..].find('>') else {
            rest = "";
            break;
        };
        if rest[open + 1..].starts_with("br") {
            text.push('\n');
        }
        rest = &rest[open + close + 1..];
    }
    text.push_str(rest);
    let entities = [
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&#39;", "'"),
        ("&nbsp;", " "),
    ];
    let decoded = entities.iter().fold(text, |text, (entity, character)| {
        text.replace(entity, character)
    });
    decoded.replace("&amp;", "&").trim().into()
}
