#!/bin/sh
# audreyt/pi-ds4 model download.
#
# Replaces the ds4 checkout's download_model.sh with one that fetches the
# preferred Headroom128 GGUF and symlinks ./ds4flash.gguf to it (resumable via
# curl -C -):
#
#   https://huggingface.co/apetersson/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128
#   DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128.gguf (~81 GiB / ~87 GB)
#
# This is the abliterated 0731 DS4 headroom build intended for 128 GB-class
# Apple Silicon machines (works from 96 GB with Metal wired-limit raised). The
# historic "q2" selector is kept so the one-line install and on-disk lease
# state stay compatible with older installs.
#
# Idempotent: if the target file is already present, just refreshes the
# symlink. Run from the ds4 support checkout (cwd = ~/.pi/ds4/support).
#
# Usage: download_model.sh <quant>
set -eu

QUANT="${1:-q2}"

if [ "$QUANT" != "q2" ]; then
    echo "audreyt/pi-ds4 only automates the preferred Headroom128 GGUF (historic quant selector: q2)." >&2
    echo "To use another quant or research-modified checkpoint, run ds4-server manually (see README)." >&2
    echo "Requested quant: $QUANT" >&2
    exit 1
fi

REPO="apetersson/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128"
MODEL_FILE="DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128.gguf"
APPROX_SIZE="~87 GB"

OUT_DIR="./gguf"
SRC_PATH="$OUT_DIR/$MODEL_FILE"
LINK_PATH="./ds4flash.gguf"

mkdir -p "$OUT_DIR"

if [ ! -s "$SRC_PATH" ]; then
    echo "ds4 download: fetching preferred Headroom128 model $MODEL_FILE ($APPROX_SIZE, one-time, resumable)..."
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
