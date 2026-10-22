// End-to-end run in headless Chrome, in a fresh profile, of the page reading the fixed images.
//
// 1. Open the page, choose the first image (a table) and press Read while the model is still
//    loading: it is read the moment the model is ready. Check the answer's character error rate
//    against the reference's, that the table is drawn (a formula: typeset), and that nothing was
//    requested after the model was ready.
// 2. Read the other images, each with its task, and check the same.
// 3. Reload: the revisit must load every part from OPFS.
//
//   PORT=8787 node e2e/run.mjs [--threads 8] [--build web-threaded] [--max-cer 0.02]
//   node e2e/run.mjs --url https://example.org    # a deployed page, no local server
//
// Results (JSON, answers, screenshots) go to e2e/results/<timestamp>-*, or to `--out <dir>`.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { characterErrorRate } from '../scripts/agreement.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({
  options: {
    threads: { type: 'string' },
    build: { type: 'string' },
    'max-cer': { type: 'string', default: '0.02' },
    url: { type: 'string' },
    model: { type: 'string' },
    out: { type: 'string' },
  },
});
const PORT = process.env.PORT ?? '8787';
const BASE = (values.url ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const DEADLINE_MS = 10 * 60 * 1000;
// Read in this order; the first while the model loads. The photographed book page is read greedily
// through near-ties, where quantized weights (and even f32 rounding) pick another word or format a
// formula another way now and then: its answer is held to `BOOK_MAX_CER`, the clean crops to
// `--max-cer`.
const BOOK_MAX_CER = 0.1;
const IMAGES = [
  { name: 'table', file: 'table.jpg' },
  { name: 'formula', file: 'formula.png' },
  { name: 'book', file: 'book.jpg', maxCer: BOOK_MAX_CER },
];
const RUN_DIR = values.out ?? join(ROOT, 'e2e/results');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const tasks = JSON.parse(readFileSync(join(ROOT, 'fixtures/tasks.json'), 'utf8'));
const references = JSON.parse(readFileSync(join(ROOT, 'fixtures/references.json'), 'utf8'));
const maxCer = Number(values['max-cer']);

const up = async () => {
  try {
    return (await fetch(`${BASE}/model/manifest.json`)).ok;
  } catch {
    return false;
  }
};
let server = null;
if (!values.url && !(await up())) {
  log(`starting fusor-ai's serve.mjs on :${PORT}`);
  const serve = join(ROOT, 'vendor/fusor-ai/scripts/serve.mjs');
  const mounts = ['--mount', '/=app/dist', '--mount', '/model/=dist/model'];
  server = spawn(process.execPath, [serve, '--port', PORT, ...mounts], { cwd: ROOT, stdio: 'inherit' });
  for (let i = 0; i < 50 && !(await up()); i++) await new Promise((r) => setTimeout(r, 200));
}

mkdirSync(RUN_DIR, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'oxr-e2e-'));
// The page's state machine is `main[data-phase]`: idle, reading, broken.
const idle = () => /^(idle|broken)$/.test(document.querySelector('main')?.dataset.phase ?? '');
const loadedOrBroken = () => document.querySelector('main')?.dataset.loaded === 'true' || document.querySelector('main')?.dataset.phase === 'broken';
const results = { started: new Date().toISOString(), base: BASE, images: {} };
const failures = [];
const check = (ok, message) => {
  log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

/** The answer and the metric tiles, as the page shows them. */
async function readPage(page) {
  const tiles = ['first', 'speed', 'tokens', 'resized', 'requests'];
  const shown = await Promise.all(tiles.map((id) => page.textContent(`#${id}`)));
  return {
    text: await page.textContent('#text'),
    cells: await page.$$eval('#answer td', (cells) => cells.length),
    formulas: await page.$$eval('#answer .formula .katex', (formulas) => formulas.length),
    status: await page.textContent('#status'),
    ...Object.fromEntries(tiles.map((id, i) => [id, shown[i]])),
  };
}

/** Chooses `image`, picks its task and presses Read; resolves once the answer is done, with the
 * requests made after the model was ready. */
async function read(page, { name, file }, requests) {
  await page.setInputFiles('#file', join(ROOT, 'fixtures/images', file));
  await page.waitForFunction(() => document.querySelector('#read') && !document.querySelector('#read').disabled, null, { timeout: DEADLINE_MS, polling: 'raf' });
  await page.click(`.task:has(input[value="${tasks[name]}"]) span`);
  const t0 = Date.now();
  await page.click('#read');
  await page.waitForFunction(loadedOrBroken, null, { timeout: DEADLINE_MS, polling: 250 });
  const mark = requests.length;
  await page.waitForFunction(idle, null, { timeout: DEADLINE_MS, polling: 250 });
  const fetched = requests.slice(mark).filter((url) => !url.startsWith('blob:'));
  return { ...(await readPage(page)), wallMs: Date.now() - t0, fetched };
}

function checkAnswer({ name, maxCer: bound = maxCer }, answer) {
  answer.cer = characterErrorRate(references[name].text, answer.text);
  check(answer.status === 'Done.', `${name} (${tasks[name]}, ${answer.resized}): first token ${answer.first}, ${answer.tokens} tokens at ${answer.speed}, ${(answer.wallMs / 1000).toFixed(1)} s in all`);
  check(answer.cer.rate <= bound, `${name} CER ${answer.cer.rate.toFixed(4)} (${answer.cer.errors}/${answer.cer.characters}, at most ${bound})`);
  check(answer.fetched.length === 0 && answer.requests === '0', `${name}: requests while reading: ${answer.fetched.length} seen, page counts ${answer.requests}`);
  if (tasks[name] === 'table') check(answer.cells > 0, `${name}: the table is drawn, ${answer.cells} cells`);
  if (tasks[name] === 'formula') check(answer.formulas > 0, `${name}: the formula is typeset, ${answer.formulas} formulas`);
}

try {
  const context = await chromium.launchPersistentContext(profile, { headless: true });
  const requests = [];
  context.on('request', (r) => requests.push(r.url()));
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('console', (m) => m.type() === 'error' && log('console:', m.text()));
  page.on('pageerror', (e) => log('pageerror:', e.message));
  const query = `?${new URLSearchParams(Object.entries({ threads: values.threads, build: values.build, model: values.model }).filter(([, v]) => v))}`;

  await page.goto(`${BASE}/${query}`);
  await page.waitForSelector('main[data-phase]');
  results.readWhileLoading = (await page.getAttribute('main', 'data-loaded')) !== 'true';
  log(`page open, the model ${results.readWhileLoading ? 'still loading' : 'loaded'}`);
  for (const image of IMAGES) {
    const answer = await read(page, image, requests);
    results.runtime ??= await page.textContent('#runtime');
    checkAnswer(image, answer);
    results.images[image.name] = answer;
    writeFileSync(join(RUN_DIR, `${STAMP}-${image.name}.txt`), `${answer.text}\n`);
    await page.screenshot({ path: join(RUN_DIR, `${STAMP}-${image.name}.png`), fullPage: true });
  }

  const t2 = Date.now();
  await page.reload();
  await page.waitForFunction(loadedOrBroken, null, { timeout: DEADLINE_MS, polling: 250 });
  results.revisitMs = Date.now() - t2;
  results.revisitDetail = await page.textContent('#runtime');
  check(/model loaded from this device/.test(results.revisitDetail), `revisit in ${(results.revisitMs / 1000).toFixed(1)} s: ${results.revisitDetail}`);
  await context.close();
} finally {
  rmSync(profile, { recursive: true, force: true });
  server?.kill();
}

results.failures = failures;
writeFileSync(join(RUN_DIR, `${STAMP}.json`), JSON.stringify(results, null, 2));
log(failures.length ? `e2e FAILED (${failures.length})` : 'e2e passed', `-> ${values.out ?? 'e2e/results'}/${STAMP}.json`);
process.exit(failures.length ? 1 : 0);
