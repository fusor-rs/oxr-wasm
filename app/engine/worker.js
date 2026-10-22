// The engine's home: a module Worker that loads the model and reads images, off the page's main
// thread.
//
// Load: fusor-ai's worker kit (`dist/host/worker.js`) starts the best runtime build and streams
// every part of the bundle into it; the runtime checks each part's size and BLAKE3.
//
// Read: the page's RGBA pixels and request start a reading (`start()`), then one `step()` per
// macrotask — the vision tower, the prompt, then one token of the answer at a time — each posted
// to the page as the whole answer so far, so a stop request is seen between steps. An image read
// before the model is ready waits for it.
//
// After the model is loaded nothing else is fetched: reading is entirely local.

import { engine, load, post, ready, requestsSinceReady, serve, yieldTask } from './dist/host/worker.js';

let stoppedJob = null;

serve({
  load: ({ modelUrl, threads, build }) =>
    load({
      modelUrl,
      threads,
      build,
      glueName: 'oxr_runtime',
      cacheName: 'oxr-parts',
      distUrl: new URL('./dist/', import.meta.url),
      onRuntime: (started) => post({ type: 'runtime', build: started.build.name, threads: started.threads }),
      onReady: (progress) => post({ type: 'ready', ...progress }),
    }),
  read,
  stop: ({ job }) => (stoppedJob = job),
});

async function read({ job, rgba, width, height, request }) {
  await ready;
  const stopped = { type: 'done', job, stopped: true, text: '', tokens: 0 };
  if (stoppedJob === job) return post(stopped);
  const { rt } = engine;
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
