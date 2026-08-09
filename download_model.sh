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

# DSpark speculative-decode support GGUF for the Headroom128 build (~5.6 GiB).
# Downloaded by default; failure is non-fatal so the main model still runs.
# Set DS4_DSPARK=0 before calling this script to skip it entirely.
DSPARK_FILE="DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128-DSpark-support.gguf"
DSPARK_SIZE_BYTES=5989114272
DSPARK_SHA256="373428b876cb77795132a829486463173206693f92ef172ada4e346e46a40e2f"

if [ "${DS4_DSPARK:-1}" != "0" ] && [ ! -s "$OUT_DIR/$DSPARK_FILE" ]; then
    # Cheap size guard: ignore files that are present but obviously truncated
    # or another model dropped under the same name.
    if [ -e "$OUT_DIR/$DSPARK_FILE" ]; then
        fsize=$(stat -f %z "$OUT_DIR/$DSPARK_FILE" 2>/dev/null || stat -c %s "$OUT_DIR/$DSPARK_FILE" 2>/dev/null || echo 0)
        if [ "$fsize" != "$DSPARK_SIZE_BYTES" ]; then
            rm -f "$OUT_DIR/$DSPARK_FILE"
        fi
    fi
fi

if [ "${DS4_DSPARK:-1}" != "0" ] && [ ! -s "$OUT_DIR/$DSPARK_FILE" ]; then
    echo "ds4 download: fetching DSpark support GGUF $DSPARK_FILE (~5.6 GiB, one-time, resumable)..."
    URL="https://huggingface.co/$REPO/resolve/main/$DSPARK_FILE"
    if [ -n "${HF_TOKEN:-}" ]; then
        curl -fL --progress-meter -C - -H "Authorization: Bearer $HF_TOKEN" -o "$OUT_DIR/$DSPARK_FILE.part" "$URL" || {
            echo "ds4 download: DSpark support download failed; continuing without speculative decode." >&2
            exit 0
        }
    else
        curl -fL --progress-meter -C - -o "$OUT_DIR/$DSPARK_FILE.part" "$URL" || {
            echo "ds4 download: DSpark support download failed; continuing without speculative decode." >&2
            exit 0
        }
    fi
    mv "$OUT_DIR/$DSPARK_FILE.part" "$OUT_DIR/$DSPARK_FILE"
    echo "ds4 download: DSpark support ready (server will run with --dspark --mtp gguf/$DSPARK_FILE)"
fi
