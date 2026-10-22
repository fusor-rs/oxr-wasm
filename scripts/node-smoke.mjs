// Runs a single-threaded wasm runtime build in Node against a bundle: pushes every part the way
// the browser loader does, then reads each PNG fixture with its task, step by step as the page
// does, and prints the time to the first token, the tokens per second and the character error
// rate against the reference's answer (fixtures/references.json).
//
//   node scripts/node-smoke.mjs dist/model --build web-single [--images fixtures/images]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { inflateSync } from 'node:zlib';
import { characterErrorRate } from './agreement.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    build: { type: 'string', default: 'web-single' },
    images: { type: 'string', default: 'fixtures/images' },
  },
});
// The PNG fixtures: Node decodes PNG with zlib alone; the JPEG ones are read in the browser (e2e).
const IMAGES = ['textline', 'formula', 'seal'];
// An answer further than this from the reference's fails the run.
const MAX_ERROR_RATE = 0.05;

const bundle = positionals[0] ?? 'dist/model';
const dist = new URL(`../app/engine/dist/${values.build}/`, import.meta.url);
const glue = await import(new URL('oxr_runtime.js', dist));
glue.initSync({ module: readFileSync(new URL('oxr_runtime_bg.wasm', dist)) });

const CHUNK = 8 << 20;
const t0 = performance.now();
const manifest = readFileSync(join(bundle, 'manifest.json'), 'utf8');
const runtime = new glue.Runtime(manifest);
let ready = false;
JSON.parse(manifest).parts.forEach((part, index) => {
  const bytes = readFileSync(join(bundle, part.file));
  for (let o = 0; o < bytes.length; o += CHUNK) runtime.write_part(index, bytes.subarray(o, o + CHUNK));
  ready = runtime.end_part(index);
});
if (!ready) throw new Error('engine not ready after every part');
console.log(`${values.build}: load ${((performance.now() - t0) / 1000).toFixed(2)}s`);

const tasks = JSON.parse(readFileSync('fixtures/tasks.json', 'utf8'));
const references = JSON.parse(readFileSync('fixtures/references.json', 'utf8'));
let failed = false;
for (const name of IMAGES) {
  const { width, height, rgba } = readPng(readFileSync(join(values.images, `${name}.png`)));
  const start = performance.now();
  runtime.start(rgba, width, height, JSON.stringify({ task: tasks[name] }));
  let progress = JSON.parse(runtime.step());
  let firstAt = null;
  while (!progress.done) {
    progress = JSON.parse(runtime.step());
    firstAt ??= performance.now();
  }
  const seconds = (performance.now() - start) / 1000;
  const first = (firstAt - start) / 1000;
  const speed = (progress.tokens - 1) / Math.max(1e-9, seconds - first);
  const { rate, errors, characters } = characterErrorRate(references[name].text, progress.text);
  console.log(`  ${name} (${tasks[name]}, ${width}×${height}): first token ${first.toFixed(2)}s, ${progress.tokens} tokens in ${seconds.toFixed(2)}s (${speed.toFixed(1)}/s); CER ${rate.toFixed(4)} (${errors}/${characters})`);
  failed ||= rate > MAX_ERROR_RATE;
}
if (failed) process.exit(1);

/** The pixels of an 8-bit, non-interlaced PNG (grey, grey and alpha, RGB or RGBA), as RGBA. */
function readPng(bytes) {
  const CHANNELS = { 0: 1, 4: 2, 2: 3, 6: 4 };
  let width = 0;
  let height = 0;
  let channels = 0;
  const data = [];
  for (let at = 8; at < bytes.length; ) {
    const size = bytes.readUInt32BE(at);
    const type = bytes.toString('ascii', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + size);
    if (type === 'IHDR') {
      [width, height] = [body.readUInt32BE(0), body.readUInt32BE(4)];
      if (body[8] !== 8 || body[12] !== 0 || !(body[9] in CHANNELS)) throw new Error('an 8-bit, non-interlaced PNG expected');
      channels = CHANNELS[body[9]];
    }
    if (type === 'IDAT') data.push(body);
    at += 12 + size;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const corner = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      pixels[y * stride + x] = (line[x] + predict(filter, left, up, corner)) & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const pixel = pixels.subarray(i * channels, (i + 1) * channels);
    const [r, g, b] = channels >= 3 ? pixel : [pixel[0], pixel[0], pixel[0]];
    rgba.set([r, g, b, channels % 2 === 0 ? pixel[channels - 1] : 255], i * 4);
  }
  return { width, height, rgba };
}

/** PNG's filter predictor of a byte from its left, upper and upper-left neighbours. */
function predict(filter, left, up, corner) {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return (left + up) >> 1;
  const estimate = left + up - corner;
  const [toLeft, toUp, toCorner] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - corner)];
  return toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : corner;
}
