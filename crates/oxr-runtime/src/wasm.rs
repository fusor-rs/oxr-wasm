use std::sync::{Mutex, Once};

use bundle::{Manifest, Store};
use oxr::session::{Engine, Request};
use oxr::{Pixels, Size};
use wasm_bindgen::prelude::*;

static LAST_PANIC: Mutex<String> = Mutex::new(String::new());
static PANIC_HOOK: Once = Once::new();

/// Channels of the pixels the page pushes: RGBA, as a canvas gives them.
const RGBA: usize = 4;

/// The message of the last panic, for the host to read after a `RuntimeError: unreachable`.
#[wasm_bindgen]
pub fn last_panic() -> String {
    LAST_PANIC
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

/// Threaded builds: `initThreadPool(n)` (wasm-bindgen-rayon) starts `n` compute workers sharing
/// this module's memory; the loader calls it before creating the `Runtime`.
#[cfg(feature = "threads")]
#[expect(
    unused_imports,
    reason = "re-exported for its #[wasm_bindgen] export, not called from Rust"
)]
pub use wasm_bindgen_rayon::init_thread_pool;

fn err(error: impl Into<oxr::Error>) -> JsError {
    let error = error.into();
    JsError::new(
        &serde_json::json!({ "kind": error.kind(), "message": error.to_string() }).to_string(),
    )
}

fn json<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("plain data serializes")
}

#[wasm_bindgen]
pub struct Runtime {
    store: Option<Store>,
    engine: Option<Engine>,
}

#[wasm_bindgen]
impl Runtime {
    #[wasm_bindgen(constructor)]
    pub fn new(manifest_json: &str) -> Result<Runtime, JsError> {
        PANIC_HOOK.call_once(|| {
            std::panic::set_hook(Box::new(|info| {
                *LAST_PANIC
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = info.to_string()
            }));
        });
        let manifest = Manifest::parse(manifest_json).map_err(err)?;
        Ok(Self {
            store: Some(Store::new(manifest).map_err(err)?),
            engine: None,
        })
    }

    fn store(&mut self) -> Result<&mut Store, JsError> {
        self.store
            .as_mut()
            .ok_or_else(|| JsError::new("the bundle was already loaded (or failed to build)"))
    }

    /// The next bytes of part `part` (index into the manifest's `parts`), in order.
    pub fn write_part(&mut self, part: usize, bytes: &[u8]) -> Result<(), JsError> {
        self.store()?.write(part, bytes).map_err(err)
    }

    /// Discards what was written to part `part` (after a failed `end_part`), to write it again.
    pub fn restart_part(&mut self, part: usize) -> Result<(), JsError> {
        self.store()?.restart_part(part).map_err(err)
    }

    /// Checks the part's size and BLAKE3; after the last part, builds the engine. Returns
    /// whether the engine is ready.
    pub fn end_part(&mut self, part: usize) -> Result<bool, JsError> {
        let store = self.store()?;
        store.end_part(part).map_err(err)?;
        if store.complete() {
            let mut store = self.store.take().expect("checked above");
            self.engine = Some(Engine::new(&mut store).map_err(err)?);
        }
        Ok(self.engine.is_some())
    }

    fn engine(&mut self) -> Result<&mut Engine, JsError> {
        self.engine
            .as_mut()
            .ok_or_else(|| JsError::new("the model is not loaded yet"))
    }

    pub fn threads(&mut self) -> Result<usize, JsError> {
        Ok(self.engine()?.threads())
    }

    /// Starts reading an image of `width × height` RGBA pixels under `request_json`
    /// (`{"task": "page" | "text" | "table" | "formula" | "code" | "chemistry", "max_tokens"?}`);
    /// returns its plan (`{"layout", "image_tokens", "prompt_tokens"}`).
    pub fn start(
        &mut self,
        rgba: Vec<u8>,
        width: usize,
        height: usize,
        request_json: &str,
    ) -> Result<String, JsError> {
        let request: Request = serde_json::from_str(request_json)
            .map_err(|error| err(oxr::Error::Request(error.to_string())))?;
        if rgba.len() != width * height * RGBA {
            return Err(err(oxr::Error::Request(format!(
                "{} bytes for a {width}×{height} RGBA image",
                rgba.len()
            ))));
        }
        let image = Pixels {
            size: Size { width, height },
            channels: RGBA,
            values: rgba,
        };
        Ok(json(&self.engine()?.start(&image, &request).map_err(err)?))
    }

    /// Runs the next stage; returns `{"stage", "text", "tokens", "done"}`, the text being the
    /// whole answer so far.
    pub fn step(&mut self) -> Result<String, JsError> {
        Ok(json(&self.engine()?.step().map_err(err)?))
    }

    pub fn cancel(&mut self) -> Result<(), JsError> {
        self.engine()?.cancel();
        Ok(())
    }
}
