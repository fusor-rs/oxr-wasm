---
title: oxr-wasm
short_description: SoMark OXR-1.0 document parsing in the browser
sdk: static
app_file: index.html
pinned: false
license: other
models:
  - fusorlabs/oxr-1.0-web
  - SoMarkAI/OXR-1.0
custom_headers:
  cross-origin-embedder-policy: require-corp
  cross-origin-opener-policy: same-origin
  cross-origin-resource-policy: cross-origin
---

Document parsing with SoMark's [OXR-1.0](https://huggingface.co/SoMarkAI/OXR-1.0), computed on
your own CPU in the browser: the model, compiled to WebAssembly with fusor-ai, downloads once and
then runs sealed from the network, reading a whole page, text, a table, a formula, code or a
chemical structure off an image you pick, as Markdown. The model is SoMark's, under the
[OXR License](https://huggingface.co/SoMarkAI/OXR-1.0/blob/main/LICENSE) (Apache-2.0 with
additional terms), which ships beside the bundle as `model/LICENSE`. The page's code is MIT; its
source is [github.com/fusor-rs/oxr-wasm](https://github.com/fusor-rs/oxr-wasm).
