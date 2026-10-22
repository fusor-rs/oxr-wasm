// The engine's home: a module Worker that loads the model and reads images, off the page's main
// thread.
//
// Load: the manifest download overlaps the runtime's compile; fusor-ai's loader picks and starts
// the best runtime build (threaded builds get their compute workers from the page) and streams
// every part of the bundle into it, from OPFS when cached there, else from the network; the
// runtime checks each part's size and BLAKE3. The runtime itself does no I/O.
//
// Read: the page's RGBA pixels and request start a reading (`start()`), then one `step()` per
// macrotask — the vision tower, the prompt, then one token of the answer at a time — each posted
// to the page as the whole answer so far, so a stop request is seen between steps. An image read
// before the model is ready waits for it.
//
// After the model is loaded nothing else is fetched: reading is entirely local.

import { describe, errorKind, fetchOk, loadParts, startRuntime } from './dist/host/loader.js';

const CACHE_DIR = 'oxr-parts';
const DIST_URL = new URL('./dist/', import.meta.url);

const post = (message, transfer) => self.postMessage(message, transfer ?? []);
// A macrotask without setTimeout's 4 ms clamp on nested timers.
const ticks = new MessageChannel();
const waiting = [];
ticks.port1.onmessage = () => waiting.shift()();
const yieldTask = () => new Promise((resolve) => {
  waiting.push(resolve);
  ticks.port2.postMessage(null);
});

let runtime = null;
let resolveReady;
const ready = new Promise((resolve) => (resolveReady = resolve));
let stoppedJob = null;
// When the model was ready: every request this worker starts later is made while reading (the
// page shows the count; it should stay 0).
let readyAt = Infinity;
const requestsSinceReady = () => performance.getEntriesByType('resource').filter((entry) => entry.startTime >= readyAt).length;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') await load(data);
    else if (data.type === 'read') await read(data);
    else if (data.type === 'stop') stoppedJob = data.job;
  } catch (error) {
    post({ type: errorKind(error) ? 'error' : 'fatal', job: data.job, message: describe(error, runtime?.glue) });
  }
};

async function load({ modelUrl, threads, build: requested }) {
  const t0 = performance.now();
  const [manifestText, started] = await Promise.all([
    fetchOk(new URL('manifest.json', modelUrl)).then((response) => response.text()),
    startRuntime({
      distUrl: DIST_URL,
      glueName: 'oxr_runtime',
      threads,
      requested,
      onWarning: (message) => post({ type: 'warning', message }),
    }),
  ]);
  const rt = new started.glue.Runtime(manifestText);
  post({ type: 'runtime', build: started.build.name, threads: started.threads });
  const progress = await loadParts({
    runtime: rt,
    manifest: JSON.parse(manifestText),
    baseUrl: modelUrl,
    cacheName: CACHE_DIR,
    onProgress: (p) => post({ type: 'progress', ...p }),
  });
  runtime = { rt, glue: started.glue };
  readyAt = performance.now();
  post({ type: 'ready', ms: performance.now() - t0, ...progress });
  resolveReady();
  await evictStaleParts(JSON.parse(manifestText));
}

/** Deletes cached parts this bundle does not name: those of earlier bundles. */
async function evictStaleParts(manifest) {
  const keep = new Set(manifest.parts.map((part) => part.blake3));
  let dir;
  try {
    dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(CACHE_DIR);
  } catch {
    return; // no OPFS, or nothing was cached
  }
  for await (const name of dir.keys()) {
    if (!keep.has(name)) await dir.removeEntry(name);
  }
}

async function read({ job, rgba, width, height, request }) {
  await ready;
  const stopped = { type: 'done', job, stopped: true, text: '', tokens: 0 };
  if (stoppedJob === job) return post(stopped);
  const { rt } = runtime;
  const plan = JSON.parse(rt.start(rgba, width, height, request));
  post({ type: 'started', job, plan });
  for (;;) {
    await yieldTask();
    if (stoppedJob === job) {
      rt.cancel();
      return post({ ...stopped, networkRequests: requestsSinceReady() });
    }
    const progress = JSON.parse(rt.step());
    const message = { job, ...progress, networkRequests: requestsSinceReady() };
    if (progress.done) return post({ ...message, type: 'done', stopped: false });
    post({ ...message, type: 'text' });
  }
}
