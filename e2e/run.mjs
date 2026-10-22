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

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetched, flags, log, run, STAMP } from '../vendor/fusor-ai/packages/e2e/kit.mjs';
import { characterErrorRate } from '../scripts/agreement.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const values = flags({
  'max-cer': { type: 'string', default: '0.02' },
});
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

const tasks = JSON.parse(readFileSync(join(ROOT, 'fixtures/tasks.json'), 'utf8'));
const references = JSON.parse(readFileSync(join(ROOT, 'fixtures/references.json'), 'utf8'));
const maxCer = Number(values['max-cer']);

// The page's state machine is `main[data-phase]`: idle, reading, broken.
const idle = () => /^(idle|broken)$/.test(document.querySelector('main')?.dataset.phase ?? '');
const loadedOrBroken = () => document.querySelector('main')?.dataset.loaded === 'true' || document.querySelector('main')?.dataset.phase === 'broken';

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
  return { ...(await readPage(page)), wallMs: Date.now() - t0, fetched: fetched(requests, mark) };
}

function checkAnswer(check, { name, maxCer: bound = maxCer }, answer) {
  answer.cer = characterErrorRate(references[name].text, answer.text);
  check(answer.status === 'Done.', `${name} (${tasks[name]}, ${answer.resized}): first token ${answer.first}, ${answer.tokens} tokens at ${answer.speed}, ${(answer.wallMs / 1000).toFixed(1)} s in all`);
  check(answer.cer.rate <= bound, `${name} CER ${answer.cer.rate.toFixed(4)} (${answer.cer.errors}/${answer.cer.characters}, at most ${bound})`);
  check(answer.fetched.length === 0 && answer.requests === '0', `${name}: requests while reading: ${answer.fetched.length} seen, page counts ${answer.requests}`);
  if (tasks[name] === 'table') check(answer.cells > 0, `${name}: the table is drawn, ${answer.cells} cells`);
  if (tasks[name] === 'formula') check(answer.formulas > 0, `${name}: the formula is typeset, ${answer.formulas} formulas`);
}

const launch = {
  root: ROOT,
  name: 'oxr',
  values,
  fields: { images: {} },
};
await run(launch, async ({ page, requests, query, base, runDir, results, check, revisit }) => {
  await page.goto(`${base}/${query}`);
  await page.waitForSelector('main[data-phase]');
  results.readWhileLoading = (await page.getAttribute('main', 'data-loaded')) !== 'true';
  log(`page open, the model ${results.readWhileLoading ? 'still loading' : 'loaded'}`);
  for (const image of IMAGES) {
    const answer = await read(page, image, requests);
    results.runtime ??= await page.textContent('#runtime');
    checkAnswer(check, image, answer);
    results.images[image.name] = answer;
    writeFileSync(join(runDir, `${STAMP}-${image.name}.txt`), `${answer.text}\n`);
    await page.screenshot({ path: join(runDir, `${STAMP}-${image.name}.png`), fullPage: true });
  }

  await revisit(loadedOrBroken, DEADLINE_MS);
});
