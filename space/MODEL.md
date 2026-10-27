---
license: other
license_name: oxr-license
license_link: LICENSE
base_model:
  - SoMarkAI/OXR-1.0
pipeline_tag: image-text-to-text
library_name: fusor-ai
tags:
  - webassembly
  - wasm
  - on-device
---

# OXR-1.0, compiled for the browser

SoMark's [OXR-1.0](https://huggingface.co/SoMarkAI/OXR-1.0) compiled into a
[fusor-ai](https://github.com/fusor-rs/fusor-ai) bundle: the weights the browser runtime of
[oxr-wasm](https://github.com/fusor-rs/oxr-wasm) loads to read documents to Markdown on the
device's CPU. Try it in the Space [fusorlabs/oxr-wasm](https://huggingface.co/spaces/fusorlabs/oxr-wasm).

- **Source:** `SoMarkAI/OXR-1.0` at revision `520bed7e90f8f4ffa110db47bdb64d5cf80ccfba`,
  compiled with the `mix` profile: 4-bit visual head, everything else 7-bit (1420 MB).
- **Format:** `manifest.json` lists every tensor and part; each part is named by its BLAKE3 hash,
  which the runtime checks as it loads.
- **Reproduce it:** `just model` in oxr-wasm downloads the checkpoint and compiles the same
  bundle.

This is not a PyTorch or safetensors checkpoint: it only loads in the oxr-wasm runtime.

The model is SoMark's, under the [OXR License](LICENSE) (Apache-2.0 with additional terms), which
applies to this bundle; a service built on it must credit SoMark OXR.
