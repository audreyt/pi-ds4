#!/bin/sh
# audreyt/pi-ds4 model download.
#
# Overrides the antirez/ds4 download_model.sh (which fetches the stock-recipe
# source GGUF) with one that downloads the cyberneurova DeepSeek-V4-Flash
# abliterated IQ2XXS-w2Q2K imatrix GGUF instead (resumable via curl -C -) and
# symlinks ./ds4flash.gguf to it.  No harmonization, no Python venv: audreyt/ds4
# main loads and runs the unmodified imatrix file directly on M-series Metal.
#
# Idempotent: if the file is already present, just refreshes the symlink.
# Run from the ds4 support checkout (cwd = ~/.pi/ds4/support).
#
# Usage: download_model.sh <quant>
set -eu

QUANT="${1:-q2}"

if [ "$QUANT" != "q2" ]; then
    echo "audreyt/pi-ds4 only automates the IQ2XXS imatrix variant. cyberneurova also publishes plain Q2_K (~99 GB) and Q8_0 (~282 GB);" >&2
    echo "to use one of those, bypass this extension and run ds4-server manually (see README)." >&2
    echo "Requested quant: $QUANT" >&2
    exit 1
fi

REPO="audreyt/CyberNeurova-DeepSeek-V4-Flash-abliterated-GGUF"
MODEL_FILE="cyberneurova-DeepSeek-V4-Flash-abliterated-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix.gguf"

OUT_DIR="./gguf"
SRC_PATH="$OUT_DIR/$MODEL_FILE"
LINK_PATH="./ds4flash.gguf"

mkdir -p "$OUT_DIR"

if [ ! -s "$SRC_PATH" ]; then
    echo "ds4 download: fetching cyberneurova abliterated IQ2XXS imatrix GGUF (~87 GB, one-time, resumable)..."
    URL="https://huggingface.co/$REPO/resolve/main/$MODEL_FILE"
    if [ -n "${HF_TOKEN:-}" ]; then
        curl -fL --progress-meter -C - -H "Authorization: Bearer $HF_TOKEN" -o "$SRC_PATH.part" "$URL"
    else
        curl -fL --progress-meter -C - -o "$SRC_PATH.part" "$URL"
    fi
    mv "$SRC_PATH.part" "$SRC_PATH"
else
    echo "ds4 download: GGUF already present ($SRC_PATH)"
fi

ln -sfn "gguf/$MODEL_FILE" "$LINK_PATH"
echo "ds4 download: ./ds4flash.gguf -> gguf/$MODEL_FILE"
