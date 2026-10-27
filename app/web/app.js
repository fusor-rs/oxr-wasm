import katex from 'katex';
import { ComputePool, SPAWN_COMPUTE } from '../../vendor/fusor-ai/packages/host/compute.js';

// The engine bridge. The page's state lives in Rust (src/app.rs); this module owns the engine
// worker and, in threaded builds, its compute workers (fusor-ai's ComputePool), and the image:
// a file chosen, dropped or pasted is decoded here to RGBA pixels and drawn as the preview, then
// handed to the engine worker when Read is pressed. It measures each reading and reports back
// with `engine` events. It also typesets the answer's formulas, displayed and inline: the page
// draws each as an empty element holding its LaTeX in `data-tex`, and KaTeX fills it.

const params = new URLSearchParams(location.search);
const cores = navigator.hardwareConcurrency || 4;
// One compute worker per core minus two (the page and the engine worker), at most 8; `?threads=1`
// forces the single-threaded build. Never more than the cores: the barriers spin.
const requestedThreads = Number.parseInt(params.get('threads') ?? '', 10);
const THREADS = Math.min(cores, requestedThreads > 0 ? requestedThreads : Math.max(1, Math.min(8, cores - 2)));
// The bundle served next to the page (`just serve` mounts dist/model there); `?model=<url>` loads
// another one, `?build=web-single` pins a runtime build.
// A Hugging Face Space holds at most 1 GB, so the Space loads the bundle from the model repo
// fusorlabs/oxr-1.0-web (`just deploy-model`) instead of from beside the page.
const HOSTED_MODEL = 'https://huggingface.co/fusorlabs/oxr-1.0-web/resolve/main/';
const DEFAULT_MODEL = location.hostname.endsWith('.hf.space') ? HOSTED_MODEL : 'model/';
const MODEL_URL = new URL(params.get('model') ?? DEFAULT_MODEL, document.baseURI).href;

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

export function onMount({ root, inputs, onCleanup }) {
  const report = (detail) => root.dispatchEvent(new CustomEvent('engine', { detail: JSON.stringify(detail) }));
  const engine = new Worker(new URL('engine/worker.js', document.baseURI), { type: 'module', name: 'oxr-engine' });
  const computePool = new ComputePool(crash);
  let build = null;
  let notice = '';
  let loaded = false;
  let broken = false;
  let jobs = 0;
  let job = null;
  let picture = null;
  let readyAt = Infinity;

  const handlers = {
    [SPAWN_COMPUTE]: (message) => computePool.spawn(message),
    runtime: (message) => (build = message),
    warning: ({ message }) => {
      console.warn(message);
      notice = ` (${message})`;
    },
    progress: ({ done, total, network, cache }) => {
      const source = cache && !network ? 'from this device' : cache ? `${mb(network)} downloaded, ${mb(cache)} cached` : 'downloading';
      report({ type: 'loading', fraction: done / total, detail: `${mb(done)} / ${mb(total)} · ${source}` });
    },
    ready: ({ ms, cache, total }) => {
      loaded = true;
      readyAt = performance.now();
      const loadedInfo = { build: `${build.build}${notice}`, threads: build.threads, bundle_bytes: total, load_ms: ms, from_device: cache === total };
      report({ type: 'ready', loaded: loadedInfo });
    },
    started: (message) => {
      if (message.job !== job?.id) return;
      const { layout, image_tokens: imageTokens } = message.plan;
      job.resized = `${layout.resized_width}×${layout.resized_height}`;
      job.imageTokens = imageTokens;
      report({ type: 'text', text: '', status: `Looking at the image: ${layout.rows * layout.columns} patches…`, metrics: metrics() });
    },
    text: (message) => {
      if (message.job !== job?.id) return;
      job.tokens = message.tokens;
      if (message.tokens > 0) job.firstAt ??= performance.now();
      const status = message.stage === 'tokenize' ? 'Reading the prompt…' : `Writing · ${message.tokens} tokens`;
      job.text = message.text;
      report({ type: 'text', text: message.text, status, metrics: metrics(message) });
    },
    done: (message) => {
      if (message.job !== job?.id) return;
      if (!message.stopped) Object.assign(job, { tokens: message.tokens, text: message.text });
      const status = message.stopped ? 'Stopped.' : 'Done.';
      report({ type: 'done', text: job.text, status, metrics: metrics(message) });
      job = null;
    },
    error: ({ message }) => {
      if (!loaded) return fail(message);
      job = null;
      report({ type: 'error', message });
    },
    fatal: ({ message }) => fail(message),
  };

  engine.onmessage = ({ data }) => {
    if (!broken) handlers[data.type]?.(data);
  };
  engine.onerror = (event) => crash(event.message || 'the engine worker failed');
  engine.postMessage({ type: 'load', modelUrl: MODEL_URL, threads: THREADS, build: params.get('build') });

  /** Decodes `file` to RGBA pixels, as stored (no color conversion), and shows it. */
  async function choose(file) {
    if (!file || job) return;
    try {
      const bitmap = await createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const { width, height } = bitmap;
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      const rgba = context.getImageData(0, 0, width, height, { colorSpace: 'srgb' }).data;
      picture = { width, height, rgba };
      preview(bitmap);
      bitmap.close();
      report({ type: 'picture', picture: { name: file.name || 'pasted image', width, height } });
    } catch (error) {
      report({ type: 'error', message: `could not read ${file.name || 'the image'} (${error?.message ?? error})` });
    }
  }

  /** Draws `bitmap` into the preview canvas at the device's pixel density; the canvas is hidden
   * until the first image, so the drop zone around it gives the width. */
  function preview(bitmap) {
    const canvas = root.querySelector('#preview');
    const scale = Math.min(1, (canvas.parentElement.clientWidth * devicePixelRatio) / bitmap.width);
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  }

  function read() {
    if (!picture) return;
    job = { id: ++jobs, t0: performance.now(), firstAt: null, tokens: 0, text: '', resized: null, imageTokens: 0 };
    const rgba = picture.rgba.slice();
    engine.postMessage({ type: 'read', job: job.id, rgba, width: picture.width, height: picture.height, request: inputs.request.get() }, [rgba.buffer]);
  }

  function stop() {
    if (job) engine.postMessage({ type: 'stop', job: job.id });
  }

  async function copy() {
    const text = root.querySelector('#text')?.textContent ?? '';
    await navigator.clipboard.writeText(text).catch(() => {}); // a refused clipboard has nothing to report
  }

  function metrics(message = {}) {
    const ownRequests = performance.getEntriesByType('resource').filter((entry) => entry.startTime >= readyAt).length;
    const now = performance.now();
    return {
      first_ms: job?.firstAt ? job.firstAt - job.t0 : null,
      tokens: job?.tokens ?? 0,
      writing_ms: job?.firstAt ? now - job.firstAt : 0,
      resized: job?.resized ?? null,
      image_tokens: job?.imageTokens ?? 0,
      requests: ownRequests + (message.networkRequests ?? 0),
    };
  }

  /** The model could not load, or the engine or a compute thread died. */
  function fail(message) {
    broken = true;
    engine.terminate();
    computePool.terminate();
    report({ type: 'broken', message });
  }

  function crash(message) {
    fail(`The engine stopped: ${message}.`);
  }

  const file = root.querySelector('#file');
  const onFile = () => {
    choose(file.files[0]);
    file.value = '';
  };
  const onDrop = (event) => {
    event.preventDefault();
    choose(event.dataTransfer?.files[0]);
  };
  const onDragOver = (event) => event.preventDefault();
  const onPaste = (event) => {
    const item = [...(event.clipboardData?.items ?? [])].find((entry) => entry.type.startsWith('image/'));
    if (item) choose(item.getAsFile());
  };
  loadFormulaFonts();
  const formulas = new MutationObserver(() => typeset(root));
  formulas.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-tex'] });
  file.addEventListener('change', onFile);
  root.addEventListener('drop', onDrop);
  root.addEventListener('dragover', onDragOver);
  document.addEventListener('paste', onPaste);
  onCleanup(onClicks(inputs.reads, read));
  onCleanup(onClicks(inputs.stops, stop));
  onCleanup(onClicks(inputs.copies, copy));
  onCleanup(() => {
    file.removeEventListener('change', onFile);
    root.removeEventListener('drop', onDrop);
    root.removeEventListener('dragover', onDragOver);
    document.removeEventListener('paste', onPaste);
    formulas.disconnect();
    engine.terminate();
    computePool.terminate();
  });
}

/** Loads KaTeX's fonts with the page rather than with the first formula, so that nothing is
 * fetched while reading. */
function loadFormulaFonts() {
  const sheet = document.querySelector('link[href$="katex.min.css"]');
  const load = () => {
    for (const face of document.fonts) {
      // A font that fails to load leaves its formulas in a fallback font: nothing to report.
      if (face.family.startsWith('KaTeX')) face.load().catch(() => {});
    }
  };
  if (sheet.sheet) load();
  else sheet.addEventListener('load', load, { once: true });
}

/** Renders every formula element under `root` whose LaTeX changed since it was last rendered. */
function typeset(root) {
  for (const element of root.querySelectorAll('[data-tex]')) {
    const tex = element.dataset.tex;
    if (element.dataset.typeset === tex) continue;
    element.dataset.typeset = tex;
    const displayMode = element.classList.contains('formula');
    katex.render(tex, element, { displayMode, throwOnError: false });
  }
}

/** Runs `action` once per click a click counter counts, clicks before this module loaded included. */
function onClicks(counter, action) {
  let seen = 0;
  return counter.subscribe((count) => {
    for (; seen < count; seen++) action();
  });
}
