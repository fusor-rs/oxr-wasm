use fusor::{JsInputs, Signal, signal};
use serde::{Deserialize, Serialize};

use crate::answer::{Block, blocks};

/// What to read off the image, as the runtime names it, and its label.
const TASKS: [(&str, &str); 6] = [
    ("page", "Whole page"),
    ("text", "Text"),
    ("table", "Table"),
    ("formula", "Formula"),
    ("code", "Code"),
    ("chemistry", "Chemical structure"),
];

/// A task as the page lists it.
#[derive(Clone, PartialEq)]
struct Task {
    id: &'static str,
    label: &'static str,
}

/// The runtime's request: `oxr::session::Request`.
#[derive(Serialize)]
struct Request<'task> {
    task: &'task str,
}

/// The image chosen, once decoded.
#[derive(Clone, PartialEq, Deserialize)]
struct Picture {
    name: String,
    width: u32,
    height: u32,
}

impl Picture {
    fn summary(&self) -> String {
        format!("{} · {}×{}", self.name, self.width, self.height)
    }
}

// The runtime build and the bundle, once loaded.
#[derive(Clone, PartialEq, Deserialize)]
struct Loaded {
    build: String,
    threads: u32,
    bundle_bytes: f64,
    load_ms: f64,
    // Every part came from this device's storage.
    from_device: bool,
}

impl Loaded {
    fn summary(&self) -> String {
        let threads = match self.threads {
            1 => "1 thread".to_string(),
            count => format!("{count} threads"),
        };
        let source = if self.from_device {
            "model loaded from this device"
        } else {
            "model downloaded"
        };
        format!(
            "{} · {threads} · {:.0} MB bundle · {source} in {:.1} s",
            self.build,
            self.bundle_bytes / 1e6,
            self.load_ms / 1000.0
        )
    }
}

/// What `web/app.js` measures while an image is read: the delay from Read to the answer's first
/// token (`first_ms`), the tokens written and the time since that first one (`writing_ms`), the
/// size the image was resized to and its tokens, and the network requests made since the model
/// loaded.
#[derive(Clone, Default, PartialEq, Deserialize)]
struct Metrics {
    first_ms: Option<f64>,
    tokens: u32,
    writing_ms: f64,
    resized: Option<String>,
    image_tokens: u32,
    requests: u32,
}

impl Metrics {
    fn first_token(&self) -> String {
        self.first_ms
            .map_or("–".into(), |ms| format!("{:.2} s", ms / 1000.0))
    }

    fn speed(&self) -> String {
        if self.tokens < 2 || self.writing_ms == 0.0 {
            return "–".into();
        }
        format!(
            "{:.0}/s",
            f64::from(self.tokens - 1) * 1000.0 / self.writing_ms
        )
    }

    fn tokens(&self) -> String {
        self.tokens.to_string()
    }

    fn image(&self) -> String {
        self.resized.clone().unwrap_or("–".into())
    }

    fn image_tokens(&self) -> String {
        match self.image_tokens {
            0 => "as the model sees it".into(),
            tokens => format!("{tokens} image tokens"),
        }
    }

    fn requests(&self) -> String {
        self.requests.to_string()
    }
}

// What `web/app.js` reports, one JSON object per `engine` event.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Report {
    Loading {
        fraction: f64,
        detail: String,
    },
    Ready {
        loaded: Loaded,
    },
    // An image was chosen and decoded.
    Picture {
        picture: Picture,
    },
    // The answer so far: the whole text, replacing the last.
    Text {
        text: String,
        status: String,
        metrics: Metrics,
    },
    Done {
        text: String,
        status: String,
        metrics: Metrics,
    },
    // Something failed; the engine can take the next request.
    Error {
        message: String,
    },
    // The model could not load, or the engine died: nothing more can run in this page.
    Broken {
        message: String,
    },
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Idle,
    Reading,
    Broken,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Reading => "reading",
            Self::Broken => "broken",
        }
    }
}

#[derive(JsInputs)]
struct App {
    task: Signal<String>,
    // `web/app.js` acts on every new count: `reads` (Read) sends the chosen image and `request`
    // to the engine, `stops` stops the reading, `copies` copies the answer.
    #[js]
    request: Signal<String>,
    #[js]
    reads: Signal<u32>,
    #[js]
    stops: Signal<u32>,
    #[js]
    copies: Signal<u32>,
    phase: Signal<Phase>,
    fraction: Signal<f64>,
    detail: Signal<String>,
    status: Signal<String>,
    picture: Signal<Option<Picture>>,
    text: Signal<String>,
    metrics: Signal<Metrics>,
    measured: Signal<bool>,
    loaded: Signal<Option<Loaded>>,
}

impl App {
    fn new() -> Self {
        Self {
            task: signal(TASKS[0].0.into()),
            request: signal(String::new()),
            reads: signal(0),
            stops: signal(0),
            copies: signal(0),
            phase: signal(Phase::Idle),
            fraction: signal(0.0),
            detail: signal("Starting…".into()),
            status: signal("Drop, paste or choose an image of a document.".into()),
            picture: signal(None),
            text: signal(String::new()),
            metrics: signal(Metrics::default()),
            measured: signal(false),
            loaded: signal(None),
        }
    }

    fn tasks(&self) -> Vec<Task> {
        TASKS.map(|(id, label)| Task { id, label }).to_vec()
    }

    fn read(&self) {
        let task = self.task.get();
        let request = Request { task: &task };
        self.request
            .set(serde_json::to_string(&request).expect("plain data serializes"));
        self.text.set(String::new());
        self.metrics.set(Metrics::default());
        self.measured.set(true);
        self.phase.set(Phase::Reading);
        let status = if self.loaded.get().is_some() {
            "Looking at the image…"
        } else {
            "Read once the model is ready."
        };
        self.status.set(status.into());
        self.reads.update(|count| *count += 1);
    }

    fn stop(&self) {
        self.stops.update(|count| *count += 1);
    }

    fn copy(&self) {
        self.copies.update(|count| *count += 1);
    }

    fn receive(&self, event: web_sys::Event) {
        let json = fusor::js::event_detail::<String>(&event).expect("web/app.js sends strings");
        let report = serde_json::from_str(&json).expect("web/app.js sends engine reports");
        match report {
            Report::Loading { fraction, detail } => {
                self.fraction.set(fraction);
                self.detail.set(detail);
            }
            Report::Ready { loaded } => self.loaded.set(Some(loaded)),
            Report::Picture { picture } => {
                self.status
                    .set(format!("{}: pick a task and read it.", picture.name));
                self.picture.set(Some(picture));
            }
            Report::Text {
                text,
                status,
                metrics,
            } => self.answer(text, status, metrics),
            Report::Done {
                text,
                status,
                metrics,
            } => {
                self.answer(text, status, metrics);
                self.phase.set(Phase::Idle);
            }
            Report::Error { message } => {
                self.status.set(format!("error: {message}"));
                self.phase.set(Phase::Idle);
            }
            Report::Broken { message } => {
                self.detail.set(message);
                self.phase.set(Phase::Broken);
            }
        }
    }

    fn answer(&self, text: String, status: String, metrics: Metrics) {
        self.text.set(text);
        self.status.set(status);
        self.metrics.set(metrics);
    }

    fn summary(&self) -> String {
        self.loaded
            .get()
            .map_or(String::new(), |loaded| loaded.summary())
    }

    fn picture_summary(&self) -> String {
        self.picture
            .get()
            .map_or(String::new(), |picture| picture.summary())
    }

    fn loading(&self) -> bool {
        self.loaded.get().is_none() && self.phase.get() != Phase::Broken
    }

    // The model never loaded: likely a bundle that does not match the runtime.
    fn failed_to_load(&self) -> bool {
        self.loaded.get().is_none()
    }

    fn idle(&self) -> bool {
        self.phase.get() == Phase::Idle
    }

    fn can_read(&self) -> bool {
        self.idle() && self.picture.get().is_some()
    }

    fn read_label(&self) -> &'static str {
        match self.phase.get() {
            Phase::Reading => "Reading…",
            _ if self.loaded.get().is_none() => "Read now, starts when ready",
            _ => "Read",
        }
    }

    fn empty(&self) -> bool {
        self.text.get().is_empty()
    }

    // The answer as the page draws it: its text, tables and code blocks in order.
    fn blocks(&self) -> Vec<Block> {
        blocks(&self.text.get())
    }
}

fusor::template!("web/index.html");
