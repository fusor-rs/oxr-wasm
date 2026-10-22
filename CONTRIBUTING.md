# Contributing

Use Rust 1.99 or later, edition 2024, Node.js 22 or later, `just`, and
[uv](https://docs.astral.sh/uv/) for the Python reference (the goldens and the PyTorch
benchmark). Clone with `--recurse-submodules` (or run `just tools`, which initializes
`vendor/fusor-ai`). `unsafe` is denied (see `AGENTS.md`).

The model, its compiler and the toolkit live in
[fusor-ai](https://github.com/fusor-rs/fusor-ai). Everything this repository takes from it
comes from `vendor/fusor-ai`, a submodule pinned to a commit pushed to fusor-ai: the model's
crates in `models/oxr`, its runtime and CLI among them, the browser host scripts, the runtime
build and the import check. To move to another fusor-ai commit, check it out in the submodule
(`git -C vendor/fusor-ai checkout <commit>`) in one change of its own, with the checks below.
Never add a crates.io pin, a `[patch]` table or a path to a fusor-ai checkout beside this one.

Run `just check` before considering a change complete. It formats and lints the page and
syntax-checks the scripts; fusor-ai's own check covers the runtime and the CLI. `just ui`
builds the page and serves it; the page is a [fusor](https://github.com/fusor-rs/fusor) app in
`app/`, built with the fusor CLI that `just tools` installs into `.tools/`. A change to the
runtime, the page, the CLI or fusor-ai also needs `just build` once, then `just runtimes`,
`just smoke`, `just parity` and `just e2e`, and a change meant to move speed `just bench`. Say
in the pull request what they showed (parity numbers, first-token time, tokens per second,
character error rate) and which fusor-ai commit they ran against.

`just images` downloads the fixed images the checks read: five of PaddleOCR's own test files
(Apache-2.0) at a pinned commit, sha256-checked, each read with the task `fixtures/tasks.json`
gives it: a Chinese text line, a table, a formula, a seal (read as text) and a photographed
book page (read as a whole page).

`just goldens` runs the reference, OXR-1.0's own modeling code in transformers 5.13.1 in f32 on
the CPU (`vendor/fusor-ai/models/oxr/reference`), on every image: its answers go to
`fixtures/references.json`, and the tensors of every stage on the first image to
`fixtures/goldens`. Three settings make it the model as SoMark serves it: the Pillow image
processor, the pixel budget of SoMark's vLLM plugin, and the image's indicators embedded as the
visual vocabulary's last words, as that plugin does it (transformers leaves the modeling code's
indicator buffer at zeros when it loads the model, which would embed both as the first word).
`just parity` compares every stage with those tensors, each stage fed the reference's own input,
using the f32 bundle (`PROFILE=f32`, 5.5 GB, native only); the preprocessing must be bit-exact
and the answer's tokens identical.

`just smoke` runs the single-threaded runtimes in Node on the PNG images and prints the time to
the first token, the tokens per second and the character error rate against the reference's
answers. `just e2e` runs the page in headless Chrome: it reads the table while the model is
still loading, then the formula and the book page, each with its task, checks the character
error rate, the drawn table, the typeset formula and that nothing was requested while reading,
and reloads to check the bundle comes from the browser's storage.

The page's formulas are typeset with [KaTeX](https://katex.org) (MIT), pinned in
`app/package.json` and bundled by the fusor CLI; its stylesheet and fonts are served beside the
page, and the fonts load with it, so that nothing is fetched while reading.

The threaded runtimes need `nightly-2025-11-15` with `rust-src`; `just tools` installs it,
and fusor-ai's `scripts/install-tools.sh` the pinned wasm-bindgen and binaryen into `.tools/`.

## The README's images

`assets/brand/banner.html` and `assets/benchmarks/benchmarks.html` are the README's banner and
benchmark summary; `node scripts/render-images.mjs` renders each into a light and a dark PNG
next to it, with the e2e's Playwright (`cd vendor/fusor-ai/packages/e2e && npm ci` first). The
benchmark page's numbers come from `benchmarks.md`: change them together.

## Deploying the site

`just site` puts the page, its four runtimes and the bundle beside it into `target/site`, a
static site that must be served cross-origin isolated to get the threaded runtimes. The bundle's
tensor parts are named by their BLAKE3 there, so caching `/model/parts/` as immutable stays
correct across recompiles, and the page deletes the parts of earlier bundles from its OPFS cache
after loading a new one.
[vercel.json](vercel.json) does that for Vercel (`just deploy`, prebuilt files, after
`vercel link`), and [space/README.md](space/README.md) for a static Hugging Face Space
(`just deploy-space`, with [uv](https://docs.astral.sh/uv/) after `hf auth login`). The site
ships the model's license beside the bundle (`model/LICENSE`) and the page credits SoMark OXR, as
the OXR License asks of an online service; keep both.

## Using AI tools

You're welcome to use AI tools, but you're responsible for everything you submit. Read and
understand every line, make sure the tests you add would fail without your change, and be ready
to explain your reasoning in review. Please don't open pull requests or issues generated
without that review.

Coding agents follow `AGENTS.md`, which is also the code standard for every change.
