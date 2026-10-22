#!/usr/bin/env bash
# Downloads the fixed images the checks read into $1, from PaddleOCR's own test files (Apache-2.0)
# at a pinned commit, each checked by sha256 (files already present are only checked). Each image
# goes with the task it is read with, in `fixtures/tasks.json`.
set -euo pipefail
DIR="$1"
REPO="https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf"
FILES="
5362ba97741413494c507237b5096ef09ed575a501c4d9e68bfeffe17528a6ad  tests/test_files/textline.png
acd113bb3a89b488941ee0962776a28e45897fa2802cd306ec3bb68d9043115c  tests/test_files/table.jpg
7885d4a349edcdfbfbc439305b8b554c2500f095949bc53d14835656b902dbcc  tests/test_files/formula.png
be29cb91999450742958c62ead08f93825b92e5fa4290c063cc7991259da6c24  tests/test_files/seal.png
782cc71a2730020ea8da815de3e40a964b7f150c183d1f8c01dd211de9dcbcc4  tests/test_files/book.jpg
"
mkdir -p "$DIR"
while read -r _ path; do
  file="$(basename "$path")"
  if [ -z "$path" ] || [ -s "$DIR/$file" ]; then continue; fi
  curl -fsSL --retry 3 -o "$DIR/$file.part" "$REPO/$path"
  mv "$DIR/$file.part" "$DIR/$file"
done <<< "$FILES"
(cd "$DIR" && awk 'NF { n = split($2, parts, "/"); print $1 "  " parts[n] }' <<< "$FILES" | shasum -a 256 -c --quiet -)
