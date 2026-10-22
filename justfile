# SoMark's OXR-1.0 in the browser. `just ui` builds everything, the model included, and serves the
# page; `just build` then `just serve` do the same in two steps.

fusor_ai := "vendor/fusor-ai"
checkpoint := env_var_or_default("CHECKPOINT", ".cache/checkpoint")
profile := env_var_or_default("PROFILE", "mix")
model := "dist/model"
model_f32 := "dist/model-f32"
goldens := "fixtures/goldens"
images := "fixtures/images"
app := "app"
engine := "app/engine/dist"
fusor := justfile_directory() / ".tools/bin/fusor"
fusor_version := "0.1.9"
port := env_var_or_default("PORT", "8787")
nice := "nice -n 19"
threads_toolchain := "nightly-2025-11-15"
wasm_bindgen_version := "0.2.129"
variants := "web-single web-single-relaxed web-threaded web-threaded-relaxed"
# The threaded builds' shared memory: the bundle, the language model's cache and a full page's
# vision activations need more than fusor-ai's 2 GB default.
max_memory := "4294967296"
version := `v=$(cargo pkgid -p oxr-cli); echo "${v##*[#@]}"`
# The reference the goldens come from (scripts/golden-harness): OXR-1.0's modeling code in
# transformers, pinned.
reference := "uv run --no-project --python 3.12 --with transformers==5.13.1 --with torch==2.14.1 --with torchvision==0.29.1 --with numpy==2.4.4 --with pillow==12.2.0 --with safetensors==0.8.0 python"

default:
    @just --list

check: lint wasm host

lint:
    cargo fmt --all -- --check
    cargo fmt --manifest-path {{app}}/Cargo.toml -- --check
    cargo clippy --manifest-path {{app}}/Cargo.toml --target wasm32-unknown-unknown --locked -- -D warnings
    cargo test --workspace --locked
    cargo clippy --workspace --all-targets --locked -- -D warnings
    cargo doc --workspace --no-deps --locked

# The runtime compiles a different kernel backend per target feature set: lint each.
wasm:
    cargo clippy -p oxr-runtime --target wasm32-unknown-unknown --locked -- -D warnings
    cargo clippy -p oxr-runtime --target wasm32-unknown-unknown --locked --target-dir target/relaxed \
      --config 'target.wasm32-unknown-unknown.rustflags=["-C", "target-feature=+simd128,+relaxed-simd"]' -- -D warnings

host:
    bash -n scripts/fetch-checkpoint.sh
    bash -n scripts/fetch-images.sh
    python3 -m py_compile scripts/golden-harness/dump.py benchmarks/pytorch.py
    node --check app/web/app.js
    node --check app/engine/worker.js
    node --check scripts/node-smoke.mjs
    node --check scripts/agreement.mjs
    node --check e2e/run.mjs
    node --check scripts/site-bundle.mjs
    node --check scripts/render-images.mjs

build: tools native model runtimes page

# The threads toolchain, and the pinned wasm-bindgen, binaryen and fusor CLI (into .tools/).
tools:
    test -f {{fusor_ai}}/Cargo.toml || git submodule update --init
    rustup target list --installed | grep -q wasm32-unknown-unknown || rustup target add wasm32-unknown-unknown
    rustup run {{threads_toolchain}} rustc --version >/dev/null 2>&1 || rustup toolchain install {{threads_toolchain}} --profile minimal --component rust-src --target wasm32-unknown-unknown --no-self-update
    {{fusor_ai}}/scripts/install-tools.sh {{wasm_bindgen_version}} > /dev/null
    {{fusor}} --version 2>/dev/null | grep -qx 'fusor {{fusor_version}}' || cargo install --root .tools fusor-cli --version {{fusor_version}} --locked
    cd {{app}} && {{fusor}} install

native:
    {{nice}} cargo build --release -p oxr-cli

# Downloads the pinned checkpoint (3.1 GB, sha256-checked) unless it is already there, then
# compiles the bundle (seconds) with the model's license beside it.
model: native
    scripts/fetch-checkpoint.sh {{checkpoint}}
    rm -rf {{model}}
    target/release/oxr compile {{checkpoint}} {{model}} --profile {{profile}}
    cp {{checkpoint}}/LICENSE {{model}}/LICENSE

# The four browser runtimes, fusor-ai's loader next to them, and the sealed-runtime check.
runtimes: tools
    for variant in {{variants}}; do MAX_MEMORY={{max_memory}} {{nice}} {{fusor_ai}}/scripts/build-runtime.sh oxr-runtime $variant {{engine}} || exit 1; done
    mkdir -p {{engine}}/host
    cp {{fusor_ai}}/packages/host/loader.js {{fusor_ai}}/packages/host/worker.js {{engine}}/host/
    for variant in {{variants}}; do \
      flags=""; case $variant in *threaded*) flags="--threaded";; esac; case $variant in *relaxed*) ;; *) flags="$flags --no-relaxed";; esac; \
      node {{fusor_ai}}/scripts/check-wasm-imports.mjs {{engine}}/$variant/oxr_runtime_bg.wasm --glue {{engine}}/$variant/oxr_runtime.js $flags || exit 1; \
    done

# The page, a fusor app, with the runtimes, into app/dist.
page:
    cd {{app}} && {{nice}} {{fusor}} build

serve:
    @echo "open http://localhost:{{port}}/"
    node {{fusor_ai}}/scripts/serve.mjs --port {{port}} --mount /={{app}}/dist --mount /model/={{model}}

# Try it on localhost. The bundle and the runtimes are rebuilt every time (incremental, seconds
# when nothing changed), so they always come from the same fusor-ai.
ui: model runtimes page serve

# The fixed images the checks read: PaddleOCR's own test files at a pinned commit (sha256-checked),
# each with its task in fixtures/tasks.json.
images:
    scripts/fetch-images.sh {{images}}

# Every stage against the reference's goldens (scripts/golden-harness), with the f32 bundle.
parity: native
    test -f {{goldens}}/golden_f32_textline.safetensors || just goldens
    scripts/fetch-checkpoint.sh {{checkpoint}}
    rm -rf {{model_f32}}
    target/release/oxr compile {{checkpoint}} {{model_f32}} --profile f32
    target/release/oxr parity {{model_f32}} {{goldens}}/golden_f32_textline.safetensors

# Golden tensors of the first image and the reference's answers on every image
# (fixtures/references.json), from the reference in f32 on the CPU (minutes).
goldens: images
    scripts/fetch-checkpoint.sh {{checkpoint}}
    {{reference}} scripts/golden-harness/dump.py {{checkpoint}} {{images}} fixtures/tasks.json {{goldens}} fixtures/references.json

bench: native images
    target/release/oxr bench {{model}} {{images}}/book.jpg --task page

# The reference's speed on this CPU (benchmarks/pytorch.py), on the same images as `just e2e`, with
# as many threads as the page's compute workers.
pytorch threads="8": images
    scripts/fetch-checkpoint.sh {{checkpoint}}
    {{reference}} benchmarks/pytorch.py {{checkpoint}} {{images}} fixtures/tasks.json {{threads}} formula seal book

# The bundle and the runtimes are rebuilt first (seconds when nothing changed): a runtime only
# loads the bundle compiled with the same fusor-ai.
smoke: model runtimes images
    node scripts/node-smoke.mjs {{model}} --build web-single
    node scripts/node-smoke.mjs {{model}} --build web-single-relaxed

e2e: model runtimes page images
    cd e2e && npm ci --no-audit --no-fund --silent && npx playwright install chromium
    PORT={{port}} node e2e/run.mjs

# The page and the bundle beside it, as one static site in target/site, the bundle's tensor parts
# named by their BLAKE3 (`vercel.json` caches them as immutable).
site: runtimes page
    rm -rf target/site
    mkdir -p target/site
    cp -R {{app}}/dist/. target/site/
    find target/site -name '.fusor-*.json' -delete
    node scripts/site-bundle.mjs {{model}} target/site/model
    cp {{model}}/LICENSE target/site/model/LICENSE

# The site to Vercel as prebuilt files (`vercel.json`): `production` or `preview`.
deploy environment="production":
    @case "{{environment}}" in production|preview) ;; *) echo "deploy: expected production or preview, got {{environment}}" >&2; exit 2 ;; esac
    vercel build {{ if environment == "production" { "--prod" } else { "" } }} --yes
    vercel deploy --prebuilt {{ if environment == "production" { "--prod" } else { "" } }} --yes

# The site to the Hugging Face Space fusorlabs/oxr-wasm, configured by space/README.md.
deploy-space: site
    #!/usr/bin/env bash
    set -euo pipefail
    cp space/README.md target/site/
    uv run --no-project --with huggingface_hub==0.36.2 python - target/site <<'PY'
    import sys
    from huggingface_hub import HfApi

    HfApi().upload_folder(
        repo_id="fusorlabs/oxr-wasm",
        repo_type="space",
        folder_path=sys.argv[1],
        delete_patterns="*",
        commit_message="Deploy oxr-wasm {{version}}",
    )
    PY
