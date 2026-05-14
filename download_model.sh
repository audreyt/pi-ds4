#!/bin/sh
# audreyt/pi-ds4 model download.
#
# Replaces the ds4 checkout's download_model.sh with one that hard-locks to
# the cyberneurova DeepSeek-V4-Flash abliterated IQ2XXS-w2Q2K aligned-imatrix
# GGUF (resumable via curl -C -) and symlinks ./ds4flash.gguf to it. The
# upstream antirez/ds4 download_model.sh would otherwise fetch the
# antirez/deepseek-v4-gguf q2 variant for the bare "q2" quant; audreyt/ds4's
# own download_model.sh routes "q2-imatrix" at the cyberneurova aligned
# variant but still supports other quants. This script ignores quant args
# other than "q2" so the one-line install always lands on a single known GGUF
# that audreyt/ds4 main loads end-to-end on M-series Metal.
#
# Idempotent: if the file is already present, just refreshes the symlink.
# Run from the ds4 support checkout (cwd = ~/.pi/ds4/support).
#
# Usage: download_model.sh <quant>
set -eu

QUANT="${1:-q2}"

if [ "$QUANT" != "q2" ]; then
    echo "audreyt/pi-ds4 only automates the IQ2XXS aligned-imatrix variant. cyberneurova also publishes plain Q2_K (~99 GB), the earlier q2-imatrix build (~87 GB), and Q8_0 (~282 GB);" >&2
    echo "to use one of those, bypass this extension and run ds4-server manually (see README)." >&2
    echo "Requested quant: $QUANT" >&2
    exit 1
fi

REPO="audreyt/CyberNeurova-DeepSeek-V4-Flash-abliterated-GGUF"
MODEL_FILE="cyberneurova-DeepSeek-V4-Flash-abliterated-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-aligned.gguf"

OUT_DIR="./gguf"
SRC_PATH="$OUT_DIR/$MODEL_FILE"
LINK_PATH="./ds4flash.gguf"

mkdir -p "$OUT_DIR"

if [ ! -s "$SRC_PATH" ]; then
    echo "ds4 download: fetching cyberneurova abliterated IQ2XXS aligned-imatrix GGUF (~87 GB, one-time, resumable)..."
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
