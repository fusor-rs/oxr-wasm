//! `oxr`: the native host of the runtime.
//!
//! - `compile`: checkpoint → bundle (the `oxr-compile` crate).
//! - `read`: PNG or JPEG images → their page, text, table, formula, code or chemical structure,
//!   with the time each took.
//! - `parity`: every stage against the reference goldens.
//! - `bench`: the milliseconds of each stage on one image.

mod bench;
mod parity;

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result};
use bundle::{Manifest, Store};
use clap::{Parser, Subcommand};
use oxr::prompt::Task;
use oxr::session::{Engine, Request};
use oxr::{Pixels, Size};

#[derive(Parser)]
#[command(name = "oxr", version)]
struct Cli {
    /// Compute threads (default: min(8, cores − 2)).
    #[arg(long, global = true)]
    threads: Option<usize>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Compile the checkpoint directory (model.safetensors and tokenizer.json, as
    /// scripts/fetch-checkpoint.sh downloads them) into a bundle.
    Compile {
        checkpoint: PathBuf,
        out: PathBuf,
        #[arg(long, default_value = "mix")]
        profile: oxr_compile::Profile,
    },
    /// Read PNG or JPEG images, each under a `# <file>` line.
    Read {
        bundle: PathBuf,
        #[arg(required = true)]
        images: Vec<PathBuf>,
        /// What to read: page, text, table, formula, code or chemistry.
        #[arg(long, default_value = "page", value_parser = task)]
        task: Task,
        #[arg(long)]
        max_tokens: Option<usize>,
    },
    /// Compare every stage with the golden tensors of the reference.
    Parity { bundle: PathBuf, goldens: PathBuf },
    /// Time each stage on an image.
    Bench {
        bundle: PathBuf,
        image: PathBuf,
        #[arg(long, default_value = "page", value_parser = task)]
        task: Task,
    },
}

fn task(name: &str) -> Result<Task, String> {
    let names = Task::ALL.map(Task::name);
    Task::ALL
        .into_iter()
        .find(|task| task.name() == name)
        .ok_or_else(|| format!("{name}: one of {}", names.join(", ")))
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let cores = std::thread::available_parallelism().map_or(4, std::num::NonZero::get);
    let threads = cli.threads.unwrap_or(8.min(cores.saturating_sub(2)).max(1));
    rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .build_global()?;
    match cli.command {
        Command::Compile {
            checkpoint,
            out,
            profile,
        } => compile(&checkpoint, &out, profile)?,
        Command::Read {
            bundle,
            images,
            task,
            max_tokens,
        } => {
            let request = Request { task, max_tokens };
            read(&mut load(&bundle)?, &images, &request)?;
        }
        Command::Parity { bundle, goldens } => parity::run(&mut load(&bundle)?, &goldens)?,
        Command::Bench {
            bundle,
            image,
            task,
        } => bench::run(&mut load(&bundle)?, &decode(&image)?, task)?,
    }
    Ok(())
}

fn compile(checkpoint: &Path, out: &Path, profile: oxr_compile::Profile) -> Result<()> {
    let start = Instant::now();
    let manifest = oxr_compile::run(checkpoint, out, profile)?;
    let mb = manifest.parts.iter().map(|part| part.bytes).sum::<u64>() as f64 / 1e6;
    println!(
        "{} tensors, {} parts, {mb:.1} MB in {:.1}s",
        manifest.tensors.len(),
        manifest.parts.len(),
        start.elapsed().as_secs_f64()
    );
    Ok(())
}

// Loads a bundle directory the way the browser does: every part pushed in order, then hashed.
pub fn load(dir: &Path) -> Result<Engine> {
    let start = Instant::now();
    let manifest = Manifest::parse(&std::fs::read_to_string(dir.join("manifest.json"))?)?;
    let mut store = Store::new(manifest.clone())?;
    for (index, part) in manifest.parts.iter().enumerate() {
        let bytes = std::fs::read(dir.join(&part.file)).with_context(|| part.file.clone())?;
        for chunk in bytes.chunks(8 << 20) {
            store.write(index, chunk)?;
        }
        store.end_part(index)?;
    }
    let engine = Engine::new(&mut store)?;
    eprintln!(
        "loaded {} ({:.0} MB) in {:.2}s, {} threads",
        dir.display(),
        manifest.tensor_bytes() as f64 / 1e6,
        start.elapsed().as_secs_f64(),
        engine.threads()
    );
    Ok(engine)
}

/// The pixels of a PNG or JPEG file, as RGBA.
fn decode(path: &Path) -> Result<Pixels> {
    let bytes = std::fs::read(path).with_context(|| path.display().to_string())?;
    let image = image::load_from_memory(&bytes)
        .with_context(|| path.display().to_string())?
        .into_rgba8();
    Ok(Pixels {
        size: Size {
            width: image.width() as usize,
            height: image.height() as usize,
        },
        channels: 4,
        values: image.into_raw(),
    })
}

fn read(engine: &mut Engine, images: &[PathBuf], request: &Request) -> Result<()> {
    for path in images {
        let image = decode(path)?;
        println!("# {}", path.display());
        let start = Instant::now();
        let plan = engine.start(&image, request)?;
        let (mut first, mut progress) = (None, engine.step()?);
        while !progress.done {
            progress = engine.step()?;
            first.get_or_insert_with(|| start.elapsed().as_secs_f64());
        }
        println!("{}", progress.text);
        let seconds = start.elapsed().as_secs_f64();
        let first = first.unwrap_or(seconds);
        eprintln!(
            "{}×{} → {} image tokens: first token after {first:.2}s, {} tokens in {seconds:.2}s \
             ({:.1} tokens/s after the first)",
            plan.layout.width,
            plan.layout.height,
            plan.image_tokens,
            progress.tokens,
            progress.tokens.saturating_sub(1) as f64 / (seconds - first).max(f64::EPSILON)
        );
    }
    Ok(())
}
