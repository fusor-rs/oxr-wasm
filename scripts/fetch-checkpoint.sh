#!/usr/bin/env bash
# Downloads what `oxr compile` and the golden harness read into $1, each file pinned by revision and
# checked by sha256 (files already present are only checked): SoMark's OXR-1.0 weights, tokenizer,
# configuration, reference code and license.
set -euo pipefail
DIR="$1"
MODEL="https://huggingface.co/SoMarkAI/OXR-1.0/resolve/520bed7e90f8f4ffa110db47bdb64d5cf80ccfba"
FILES="
c0284b582e14987fbd3d5a2cb2bd139084371ed9acbae488829a1c900833c680  added_tokens.json
8d6f5059459a1d4d91da3c9e7d17cb19d4544eaa2dc0c07a10b61be3c918e970  chat_template.jinja
758481181d106aef0a0a22c6059f2ab2a224ec1cba2b2c8d8255cb3ce99a0b24  config.json
79b82be9ab046f095cda04a79b5cba3e0dcb4063759f3c11e39485b2242a2c50  configuration_oxr.py
ce3df60200308da1ed68ac498048baca9464e38b020b64761548cb3973d65948  generation_config.json
4577df88e499926976b390c4ea3992cc91baa9ebac29386f35b557bd3cb4a662  LICENSE
8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5  merges.txt
3c3561057eb1f2ac8bea3da397e0f3ba959abcad9c8ff61a8b7b723f5bf56042  modeling_oxr.py
63ff380d3e424f93e6fbca5cc8e74eeed882e96fd6be2b7728aed308f3ad1513  preprocessor_config.json
6676f091c8bc4d1b50146427cfde92073402866b87b6e39223227931b70083e9  special_tokens_map.json
0e18563d7a30d4d8f8c344410fb256f0c4de7b66146872e5afb01caf7b767372  tokenizer_config.json
aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4  tokenizer.json
ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910  vocab.json
795bb2f1faac579f58829913f2c606202531a96c1203e19ef7a70b103fb7ea51  model.safetensors
"
mkdir -p "$DIR"
while read -r _ file; do
  if [ -z "$file" ] || [ -s "$DIR/$file" ]; then continue; fi
  echo "downloading $file"
  curl -fsSL --retry 3 -o "$DIR/$file.part" "$MODEL/$file"
  mv "$DIR/$file.part" "$DIR/$file"
done <<< "$FILES"
(cd "$DIR" && awk 'NF { print $1 "  " $2 }' <<< "$FILES" | shasum -a 256 -c --quiet -)
