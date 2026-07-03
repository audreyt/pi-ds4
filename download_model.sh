#!/bin/sh
# audreyt/pi-ds4 model download.
#
# Replaces the ds4 checkout's download_model.sh with one that auto-selects
# between two cyberneurova DeepSeek-V4-Flash abliterated GGUFs based on
# detected RAM, and symlinks ./ds4flash.gguf to the chosen file (resumable
# via curl -C -):
#
#   - 128 GB+ Macs: mixed-quant build (layers 37-42 spliced in at Q4_K,
#     everything else IQ2XXS-w2Q2K aligned-imatrix; ~91 GB). The splice
#     trades ~4 GB of extra disk for output that tracks the full Q4 build
#     more closely on the six spliced layers, at near-identical throughput
#     to the plain IQ2XXS build (see README benchmarks).
#   - 96-127 GB Macs: plain IQ2XXS-w2Q2K aligned-imatrix build (~87 GB) —
#     the mixed build's ~97.6 GB weight payload does not fit under 128 GB.
#
# The upstream antirez/ds4 download_model.sh would otherwise fetch the
# antirez/deepseek-v4-gguf q2 variant for the bare "q2" quant; audreyt/ds4's
# own download_model.sh routes "q2-imatrix" at the cyberneurova aligned
# variant but still supports other quants. This script ignores quant args
# other than "q2" so the one-line install always lands on a single known,
# RAM-appropriate GGUF that audreyt/ds4 main loads end-to-end on M-series
# Metal.
#
# Idempotent: if the target file is already present, just refreshes the
# symlink. Run from the ds4 support checkout (cwd = ~/.pi/ds4/support).
#
# Usage: download_model.sh <quant>
set -eu

QUANT="${1:-q2}"

if [ "$QUANT" != "q2" ]; then
    echo "audreyt/pi-ds4 only automates the RAM-tiered aligned-imatrix variants (mixed on 128 GB+, plain on 96-127 GB). cyberneurova also publishes plain Q2_K (~99 GB), a full Q4KExperts build (~154 GB), and Q8_0 (~282 GB);" >&2
    echo "to use one of those, bypass this extension and run ds4-server manually (see README)." >&2
    echo "Requested quant: $QUANT" >&2
    exit 1
fi

REPO="audreyt/CyberNeurova-DeepSeek-V4-Flash-abliterated-GGUF"

# RAM detection (decimal GB, matches index.ts's totalmem()/1e9 comparison).
RAM_BYTES=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
RAM_GB=$((RAM_BYTES / 1000000000))

if [ "$RAM_GB" -ge 128 ]; then
    MODEL_FILE="cyberneurova-DeepSeek-V4-Flash-abliterated-Layers37-42Q4KExperts-mixed.gguf"
    APPROX_SIZE="~91 GB"
else
    MODEL_FILE="cyberneurova-DeepSeek-V4-Flash-abliterated-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-aligned.gguf"
    APPROX_SIZE="~87 GB"
fi

OUT_DIR="./gguf"
SRC_PATH="$OUT_DIR/$MODEL_FILE"
LINK_PATH="./ds4flash.gguf"

mkdir -p "$OUT_DIR"

if [ ! -s "$SRC_PATH" ]; then
    echo "ds4 download: detected ${RAM_GB} GB RAM; fetching $MODEL_FILE ($APPROX_SIZE, one-time, resumable)..."
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
