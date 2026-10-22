# Benchmarks

How fast OXR-1.0 reads on one machine, in every runtime this project has: the page in Chrome
(eight threads and one), the native `oxr` CLI, the single-threaded runtimes in Node, and the
PyTorch reference on the CPU. Everything here was measured on 2026-10-22 on the machine below;
nothing is quoted from elsewhere.

Reading an image has two phases, and the tables give both. **First token** is the time from the
image to the answer's first token: the preprocessing, the vision tower over every 16×16 patch,
the visual vocabulary and the prompt through the language model. It grows with the image: a
text line is 800–900 patches, a page up to 3600. **Tokens per second** is the speed of the
answer after that first token, one greedy token at a time. **CER** is the character error rate
of the answer against the reference's on the same image (0 is identical).

## The machine

| | |
|---|---|
| Computer | Apple M4 Pro, 14 cores (10 performance, 4 efficiency), 24 GB |
| OS | macOS 27.0.1 (Darwin 27.0.0) |
| Native CLI | `oxr` 0.1.0, Rust 1.99.0, release build |
| Browser | Chrome headless shell (Playwright 1.64.1), Node 22.16.0 |
| PyTorch | torch 2.14.1, transformers 5.13.1, f32, the golden harness's reference (`benchmarks/pytorch.py`) |
| Bundle | `mix`, 1420 MB: a 4-bit visual head, every other large matrix 7-bit |

Other work ran on the machine throughout (1-minute load average 4–16 on 14 cores), which slows
the spinning thread team more than PyTorch's. The eight-thread numbers in Chrome and natively
are medians of three runs (the spread beside them); the rest are one run each, so read them as
their order of magnitude. Rerun them with `just e2e` (add `--threads 1`), `just smoke`,
`target/release/oxr read`, and `just pytorch`.

## The images

PaddleOCR's own test files (Apache-2.0), each read with its task (`fixtures/tasks.json`):

| Image | Task | Size | Resized to | Patches | Image tokens |
|---|---|---:|---:|---:|---:|
| `textline.png` | text | 514×64 | 1280×160 | 800 | 200 |
| `table.jpg` | table | 551×132 | 928×224 | 812 | 203 |
| `formula.png` | formula | 448×64 | 1216×192 | 912 | 228 |
| `seal.png` | text | 640×640 | 640×640 | 1600 | 400 |
| `book.jpg` | page | 1100×708 | 1088×704 | 2992 | 748 |

## In Chrome

`just e2e` (threaded, relaxed SIMD, eight compute threads) and `just e2e --threads 1`
(single-threaded, relaxed SIMD). The first image is read while the model loads, so its first
token includes the end of the load; the table row says so.

| Image | Threads | First token | Tokens per second | Tokens | CER |
|---|---:|---:|---:|---:|---:|
| table | 8 | 3.52 s (with the load) | 213 | 130 | 0 |
| formula | 8 | 1.29 s (1.28–1.30) | 213 (208–221) | 97 | 0.0098 |
| book | 8 | 5.32 s (5.27–5.58) | 167 (146–169) | 584 | 0 |
| table | 1 | 8.81 s (with the load) | 70 | 130 | 0 |
| formula | 1 | 7.30 s | 71 | 97 | 0.0098 |
| book | 1 | 32.18 s | 52 | 584 | 0 |

Every run made no network request after the model was ready (the formula typesetter's fonts load
with the page), and the revisit loaded the 1420 MB bundle from the browser's storage in about
two seconds.

## Native, against PyTorch

`target/release/oxr read dist/model <image> --task <task> --threads <n>`, and `just pytorch 8`
(`torch.set_num_threads(8)`; the first token and the last timed in the same `generate`, after a
warm-up read). Eight threads: medians of three rounds, ours and PyTorch's alternating.

| Image | Runtime | Threads | First token | Tokens per second |
|---|---|---:|---:|---:|
| formula | oxr-wasm, native | 8 | 1.29 s | 249 |
| formula | PyTorch, f32 | 8 | 1.70 s | 31 |
| seal | oxr-wasm, native | 8 | 2.47 s | 236 |
| seal | PyTorch, f32 | 8 | 2.23 s | 34 |
| book | oxr-wasm, native | 8 | 5.49 s | 190 |
| book | PyTorch, f32 | 8 | 4.30 s | 29 |
| formula | oxr-wasm, native | 1 | 9.66 s | 79 |
| seal | oxr-wasm, native | 1 | 18.82 s | 68 |
| book | oxr-wasm, native | 1 | 41.24 s | 56 |

The answer is where fusor-ai wins: 7–8× PyTorch's tokens per second, because each token is a
handful of 7-bit matrix-vector products with no framework in between. The first token is where
it loses on large images: PyTorch's f32 matrix products go through Apple's Accelerate, which
runs them on the M4's matrix units, and on the 1600- and 2992-patch images they finish the
vision tower 1.1–1.3× sooner than fusor-ai's int8 SIMD kernels, which are written for
WebAssembly first. On a crop fusor-ai is sooner. PyTorch has no browser build.

## In Node

`just smoke`: the single-threaded runtimes, on the PNG images.

| Build | Image | First token | Tokens per second | CER |
|---|---|---:|---:|---:|
| SIMD128 | textline | 26.67 s | 20 | 0 |
| SIMD128 | formula | 29.32 s | 23 | 0 |
| SIMD128 | seal | 55.40 s | 21 | 0 |
| relaxed SIMD | textline | 8.78 s | 63 | 0 |
| relaxed SIMD | formula | 8.94 s | 70 | 0.0098 |
| relaxed SIMD | seal | 17.24 s | 64 | 0 |

The SIMD128 builds (browsers without relaxed SIMD) run about a third as fast as the relaxed ones
with fusor-ai's current kernels; paddle-ocr-wasm's SIMD128 runtime, built from the same
fusor-ai, shows the same gap.

## Agreement with the reference

`just parity` feeds each stage the reference's own input, with the f32 bundle, on `textline.png`:

| Stage | Relative L2 | Max abs |
|---|---:|---:|
| Preprocessing (Pillow-exact bilinear resize, patches) | 0 | 0 |
| Patch embedding and bicubic position grid | 4.7·10⁻⁷ | 1.6·10⁻⁵ |
| Vision encoder (27 layers) | 1.6·10⁻² | 4.9 |
| Visual vocabulary (head, LayerNorm, softmax, mixture) | 1.2·10⁻⁵ | 3.4·10⁻⁶ |
| Prompt ids | identical | |
| Prefill: last hidden state | 2.0·10⁻⁶ | 3.3·10⁻⁵ |
| Prefill: logits | 2.2·10⁻⁶ | 2.2·10⁻⁵ |
| Greedy answer | 7 of 7 tokens identical | |

The vision encoder's attention runs on fusor-ai's int8 kernels (`blocks::attention`: keys and
values quantized per head, the keys' mean subtracted first), which is where its 1.6% comes from;
every other stage agrees with PyTorch within 2·10⁻⁵.

Quantized, against the reference's answers (native CLI):

| Bundle | Size | textline | table | formula | seal | book |
|---|---:|---:|---:|---:|---:|---:|
| f32 | 5531 MB | 0 | 0 | 0 | 0 | 0.0034 |
| `q7`: every large matrix 7-bit | 1571 MB | 0 | 0 | 0 | 0 | 0 |
| `mix`: the visual head 4-bit | 1420 MB | 0 | 0 | 0.0098 | 0 | 0 |
| vision layers 4-bit too | 1214 MB | 0 | 0 | 0 | 0 | 0.0086 |
| vision and language model layers 4-bit too | 994 MB | 0 | 0 | 0 | 0 | 0.0048 |

The fixed images do not separate the last two rows from `mix`; a denser page does. On three pages
cropped from the parsing examples in SoMark's README (an academic paper and a page of code read
as pages, and a dense table of numbers), `q7` and `mix` read all three exactly as the reference,
while 4-bit vision layers flip the table's first, half-cut header row and read it on from there
differently (83% of its 656 cells as the reference's), and a 4-bit language model on top of that
does worse (68%); a 4-bit language model alone, over 7-bit vision layers, loses the table too. `mix`'s one difference, on the formula, is where its single alignment mark
sits (`\zeta_{0}(\nu)&=` against the reference's `&\zeta_{0}(\nu)=`), which typesets the same.
