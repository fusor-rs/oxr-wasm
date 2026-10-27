# SoMark's OXR-1.0 in the browser. `just ui` builds everything, the model included, and serves the
# page; `just build` then `just serve` do the same in two steps.

import 'vendor/fusor-ai/just/product.just'

name := "oxr"
checkpoint := env_var_or_default("CHECKPOINT", ".cache/checkpoint")
profile := env_var_or_default("PROFILE", "mix")
model_f32 := "dist/model-f32"
goldens := "fixtures/goldens"
images := "fixtures/images"
# The threaded builds' shared memory: the bundle, the language model's cache and a full page's
# vision activations need more than fusor-ai's 2 GB default.
export MAX_MEMORY := "4294967296"
# The reference the goldens come from (vendor/fusor-ai/models/oxr/reference): OXR-1.0's modeling
# code in transformers, pinned.
reference := "uv run --no-project --python 3.12 --with transformers==5.13.1 --with torch==2.14.1 --with torchvision==0.29.1 --with numpy==2.4.4 --with pillow==12.2.0 --with safetensors==0.8.0 python"

host:
    bash -n scripts/fetch-checkpoint.sh
    bash -n scripts/fetch-images.sh
    python3 -m py_compile benchmarks/pytorch.py
    node --check app/web/app.js
    node --check app/engine/worker.js
    node --check scripts/node-smoke.mjs
    node --check scripts/agreement.mjs
    node --check e2e/run.mjs
    node --check scripts/site-bundle.mjs
    node --check scripts/render-images.mjs

# Downloads the pinned checkpoint (3.1 GB, sha256-checked) unless it is already there, then
# compiles the bundle (seconds) with the model's license beside it.
model: native
    scripts/fetch-checkpoint.sh {{checkpoint}}
    rm -rf {{model}}
    target/release/oxr compile {{checkpoint}} {{model}} --profile {{profile}}
    cp {{checkpoint}}/LICENSE {{model}}/LICENSE

# Try it on localhost. The bundle and the runtimes are rebuilt every time (incremental, seconds
# when nothing changed), so they always come from the same fusor-ai.
ui: model runtimes page serve

# The fixed images the checks read: PaddleOCR's own test files at a pinned commit (sha256-checked),
# each with its task in fixtures/tasks.json.
images:
    scripts/fetch-images.sh {{images}}

# Every stage against the reference's goldens (vendor/fusor-ai/models/oxr/reference), with the f32
# bundle.
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
    {{reference}} {{fusor_ai}}/models/oxr/reference/dump.py {{checkpoint}} {{images}} fixtures/tasks.json {{goldens}} fixtures/references.json

bench: native images
    target/release/oxr bench {{model}} {{images}}/book.jpg --task page

# The reference's speed on this CPU (benchmarks/pytorch.py), on the same images as `just e2e`, with
# as many threads as the page's compute workers.
pytorch threads="8": images
    scripts/fetch-checkpoint.sh {{checkpoint}}
    {{reference}} benchmarks/pytorch.py {{checkpoint}} {{images}} fixtures/tasks.json {{threads}} formula seal book

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

# The Space holds at most 1 GB, so it gets the page, the runtimes and the model's licenses, and the
# page loads the bundle from the model repo fusorlabs/oxr-1.0-web (`just deploy-model`). The Space must
# already exist as a static Space: creating it with the upload makes a Gradio Space, which
# Hugging Face refuses for a free organization.
# The site to the Hugging Face Space fusorlabs/oxr-wasm, configured by space/README.md.
deploy-space: site
    #!/usr/bin/env bash
    set -euo pipefail
    rm -rf target/space
    rsync -a --exclude /model target/site/ target/space/
    rsync -a --include '*/' --include 'LICENSE*' --include NOTICE --exclude '*' target/site/model/ target/space/model/
    cp space/README.md target/space/
    uv run --no-project --with huggingface_hub==0.36.2 python - target/space <<'PY'
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

# Deploy it before the Space whenever the bundle changes: the runtime only loads a bundle compiled
# with the same fusor-ai.
# The site's bundle, with space/MODEL.md as its card, to the model repo fusorlabs/oxr-1.0-web.
deploy-model: site
    #!/usr/bin/env bash
    set -euo pipefail
    cp space/MODEL.md target/site/model/README.md
    uv run --no-project --with huggingface_hub==0.36.2 python - target/site/model <<'PY'
    import sys
    from huggingface_hub import HfApi

    api = HfApi()
    api.create_repo("fusorlabs/oxr-1.0-web", exist_ok=True)
    api.upload_folder(
        repo_id="fusorlabs/oxr-1.0-web",
        folder_path=sys.argv[1],
        delete_patterns="*",
        commit_message="Deploy the oxr-wasm {{version}} bundle",
    )
    PY

# The fixed inputs the checks read.
fixtures: images
