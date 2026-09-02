#!/bin/sh
# audreyt/pi-ds4 model download.
#
# Fetches the preferred Vision-Exp language GGUF (official IQ2 recipe with
# the published rank-1 wo_b graft) and the unmodified 316-tensor encoder,
# then symlinks ./ds4flash.gguf to the language file (resumable via curl -C -).
#
#   language: audreyt/DeepSeek-V4-Flash-Vision-Exp-Abliterated-GGUF
#             DeepSeek-V4-Flash-Vision-Exp-Abliterated-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf
#             86720111776 bytes (~80.76 GiB)
#   encoder:  antirez/deepseek-v4-gguf
#             DeepSeek-V4-Flash-Vision-Encoder.gguf
#             932857760 bytes
#
# This is Vision-Exp, not Headroom128 0731 Flash. ds4-server must be started
# with --vision gguf/DeepSeek-V4-Flash-Vision-Encoder.gguf. Do not attach the
# 0731 DSpark support GGUF to this checkpoint.
#
# The historic "q2" selector is kept so the one-line install and on-disk lease
# state stay compatible with older installs.
# After the Vision-Exp language+encoder pair passes size checks and
# ./ds4flash.gguf is switched, known v0.5 Headroom128/DSpark files are removed.
# They are not deleted before that, so a failed fetch keeps the working 0731 model.
#
# Idempotent: if the target files are already present at the expected sizes,
# just refreshes the symlink. Run from the ds4 support checkout
# (cwd = ~/.pi/ds4/support).
#
# Usage: download_model.sh [q2|preferred]
#   q2         historic selector, preferred Vision-Exp abliterated IQ2 (default)
#   preferred  alias for q2 — DeepSeek-V4-Flash-Vision-Exp-Abliterated-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf + DeepSeek-V4-Flash-Vision-Encoder.gguf
set -eu

QUANT="${1:-q2}"
# Normalize preferred alias to q2 for backward compat with ds4's ./download_model.sh preferred
if [ "$QUANT" = "preferred" ] || [ "$QUANT" = "vision-abliterated" ] || [ "$QUANT" = "ds4f-vision-abliterated" ]; then
    QUANT="q2"
fi

if [ "$QUANT" != "q2" ]; then
    echo "audreyt/pi-ds4 only automates the preferred Vision-Exp abliterated IQ2 GGUF (historic quant selector: q2, alias: preferred)." >&2
    echo "To use another quant or research-modified checkpoint, run ds4-server manually (see README)." >&2
    echo "Requested quant: $QUANT" >&2
    exit 1
fi

LANG_REPO="audreyt/DeepSeek-V4-Flash-Vision-Exp-Abliterated-GGUF"
LANG_REV="367a1fefb91ba1f76eb151abc15c68172e1f1cb7"
LANG_FILE="DeepSeek-V4-Flash-Vision-Exp-Abliterated-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf"
LANG_BYTES=86720111776
ENC_REPO="antirez/deepseek-v4-gguf"
ENC_REV="f71f23d552d664e523b422157b2befbf74040380"
ENC_FILE="DeepSeek-V4-Flash-Vision-Encoder.gguf"
ENC_BYTES=932857760

OUT_DIR="./gguf"
SRC_PATH="$OUT_DIR/$LANG_FILE"
ENC_PATH="$OUT_DIR/$ENC_FILE"
LINK_PATH="./ds4flash.gguf"

mkdir -p "$OUT_DIR"

file_size() {
    stat -f %z "$1" 2>/dev/null || stat -c %s "$1" 2>/dev/null || echo 0
}

curl_hf() {
    dest="$1"
    url="$2"
    if [ -n "${HF_TOKEN:-}" ]; then
        curl -fL --progress-meter -C - -H "Authorization: Bearer $HF_TOKEN" -o "$dest" "$url"
    else
        curl -fL --progress-meter -C - -o "$dest" "$url"
    fi
}

if [ -s "$SRC_PATH" ] && [ "$(file_size "$SRC_PATH")" = "$LANG_BYTES" ]; then
    echo "ds4 download: language GGUF already present ($SRC_PATH)"
else
    if [ -e "$SRC_PATH" ]; then
        echo "ds4 download: removing size-mismatched language GGUF ($(file_size "$SRC_PATH") != $LANG_BYTES)" >&2
        rm -f "$SRC_PATH"
    fi
    echo "ds4 download: fetching Vision-Exp language GGUF $LANG_FILE (~80.76 GiB, one-time, resumable)..."
    URL="https://huggingface.co/$LANG_REPO/resolve/$LANG_REV/$LANG_FILE"
    curl_hf "$SRC_PATH.part" "$URL"
    mv "$SRC_PATH.part" "$SRC_PATH"
    if [ "$(file_size "$SRC_PATH")" != "$LANG_BYTES" ]; then
        echo "ds4 download: language GGUF size $(file_size "$SRC_PATH") != $LANG_BYTES" >&2
        exit 1
    fi
fi



if [ -s "$ENC_PATH" ] && [ "$(file_size "$ENC_PATH")" = "$ENC_BYTES" ]; then
    echo "ds4 download: encoder already present ($ENC_PATH)"
else
    if [ -e "$ENC_PATH" ]; then
        echo "ds4 download: removing size-mismatched encoder ($(file_size "$ENC_PATH") != $ENC_BYTES)" >&2
        rm -f "$ENC_PATH"
    fi
    echo "ds4 download: fetching Vision-Exp encoder $ENC_FILE (~889 MiB, one-time, resumable)..."
    URL="https://huggingface.co/$ENC_REPO/resolve/$ENC_REV/$ENC_FILE"
    curl_hf "$ENC_PATH.part" "$URL"
    mv "$ENC_PATH.part" "$ENC_PATH"
    if [ "$(file_size "$ENC_PATH")" != "$ENC_BYTES" ]; then
        echo "ds4 download: encoder size $(file_size "$ENC_PATH") != $ENC_BYTES" >&2
        exit 1
    fi
fi

echo "ds4 download: encoder ready (server must run with --vision gguf/$ENC_FILE)"

ln -sfn "gguf/$LANG_FILE" "$LINK_PATH"
echo "ds4 download: ./ds4flash.gguf -> gguf/$LANG_FILE"

# Only after language+encoder size checks and the ds4flash symlink switch.
# Deleting first would leave a failed download with no working model.
if [ -s "$SRC_PATH" ] && [ "$(file_size "$SRC_PATH")" = "$LANG_BYTES" ] \
    && [ -s "$ENC_PATH" ] && [ "$(file_size "$ENC_PATH")" = "$ENC_BYTES" ]; then
    for obsolete in \
        "$OUT_DIR/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128.gguf" \
        "$OUT_DIR/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128.gguf.part" \
        "$OUT_DIR/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128-DSpark-support.gguf" \
        "$OUT_DIR/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128-DSpark-support.gguf.part"
    do
        if [ -e "$obsolete" ]; then
            echo "ds4 download: removing obsolete v0.5 artifact $obsolete"
            rm -f "$obsolete"
        fi
    done
fi
