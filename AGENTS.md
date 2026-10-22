# AGENTS.md

Rules for coding agents in this repository that are its own. fusor-ai's
`vendor/fusor-ai/AGENTS.md` is the standard and binds here too (`CLAUDE.md`
imports both); this file adds what is particular to this product.

oxr-wasm is the OXR-1.0 (SoMarkAI/OXR-1.0) document parser: the model, a 1.3B
vision-language model (a SigLIP2 NaViT vision encoder, a probabilistic visual
vocabulary and Qwen3 0.6B), running in the browser on the CPU, sealed from the
network, reading a whole page, text, a table, a formula, code or a chemical
structure off an image as Markdown. The README describes what it does; don't
invent scope, features or options beyond the task.

## Repository

- `vendor/fusor-ai/models/oxr/runtime`: the wasm-bindgen surface of the model
  (bundle parts and RGBA pixels in, the answer's text out), built as four
  browser runtimes.
- `vendor/fusor-ai/models/oxr/cli`: the native CLI `oxr` (`compile`, `read`,
  `bench`, `parity`).
- `app/`: the page, a [fusor](https://github.com/fusor-rs/fusor) app with its own
  Cargo workspace (fusor pins wasm-bindgen 0.2.117, the runtime 0.2.129): the
  image, the task, reading and the live measurements as Rust signals in
  `src/app.rs`, the answer split into text, formulas, code and tables in
  `src/answer.rs`, the template in `web/index.html`, the engine bridge, the
  image decoding and the formula typesetting (KaTeX, pinned in `package.json`,
  its stylesheet and fonts served beside the page) in `web/app.js`, and in
  `engine/` the engine worker, beside the runtimes `just runtimes` builds.
- `scripts/`: the checkpoint and image downloads (pinned, sha256-checked), the
  Node smoke test and the character error rate; `e2e/run.mjs`: the headless
  Chrome run; `fixtures/`: each image's task and the reference's answers.
- [fusor-ai](https://github.com/fusor-rs/fusor-ai): the model (`oxr`), its
  compiler (`oxr-compile`), the kernels, blocks and bundle format come from
  `vendor/fusor-ai`, a git submodule pinned to a commit pushed to fusor-ai, with
  the browser loader and compute pool, the runtime build, the import check and
  the dev server.

What belongs where: model code (dimensions, tensor names, wiring, the image
preprocessing, the visual vocabulary, the prompts, the reading loop) and
anything another model could reuse go to fusor-ai, following its `AGENTS.md`.
This repository holds what turns the model into an app: the page, the checks
against the reference and the deployment. A change to fusor-ai lands there
first; this repository never patches it.

Constraints that hold everywhere:

- fusor-ai comes only from `vendor/fusor-ai`, never a crates.io version, a
  `[patch]` table or a sibling checkout. The submodule moves to another pushed
  fusor-ai commit in a change of its own, with the parity numbers and the e2e
  result it gave. No copies of fusor-ai code here.
- The reference is OXR-1.0's own modeling code in transformers at the version
  the golden harness pins, with its Pillow image processor (bilinear), SoMark's
  pixel budget (its vLLM plugin's 200 704 to 921 600 pixels) and the image's
  indicators embedded as the visual vocabulary's last words, as the vLLM plugin
  does it: transformers leaves the modeling code's non-persistent indicator
  buffer at zeros when it loads the model. Preprocessing must stay bit-exact
  with Pillow's.
- The page owns every capability: decoding the image (file, drop or paste) to
  RGBA pixels, caching the bundle (OPFS), typesetting formulas and measuring
  itself. The runtime receives pixels and does no I/O. Nothing is fetched
  while reading: KaTeX's fonts load with the page.
- The model is under the OXR License (Apache-2.0 with additional terms): the
  page, the README and the Space identify SoMark OXR prominently and credit
  SoMark with links, and the bundle ships the license beside it
  (`model/LICENSE`). Don't remove either.

## Checks

A change is done only when this passes:

```sh
just check
```

It runs formatting and Clippy on the page and syntax checks of the scripts;
fusor-ai's `just check` covers the runtime and the CLI. A change to the runtime,
the page, the CLI or fusor-ai also needs `just runtimes`, `just smoke`, `just
parity` (the same numbers as before unless the change is meant to move them) and
`just e2e`, whose character error rate against the reference's answers on its
fixed images must not rise; a change meant to move speed also needs `just
bench`. The model is checked stage by stage against the reference goldens by
`oxr parity`; extend it rather than adding a parallel harness.

## Measuring

A speed change is judged on the page (`web-threaded-relaxed`, 8 workers, headless
Chrome through `just e2e`): the cold and warm first token first, tokens per
second second. Medians of at least three fresh-profile runs with their spread and
the machine's load average; a change smaller than the spread is not a result, and
nothing else runs on the machine during a measurement. `oxr bench` explains where
the time went, stage by stage. Numerically every accepted change is bit-exact
unless it is meant to move the numbers: the fixed images read to the same text,
`just parity` prints the same digits. fusor-ai's `knowledge.md`
records what the measurements taught about V8, the kernels and their stores.

## Commits

- Don't commit, push, tag, release or deploy unless asked. Deploying is
  described in `CONTRIBUTING.md` and is done by the maintainer.
- Git runs as `andreespirela` here: the local config pins the author, the
  credential user and the remote URL, as in the other fusor repositories. Don't
  change it, and clone fusor repositories with
  `https://andreespirela@github.com/fusor-rs/<name>.git`.
