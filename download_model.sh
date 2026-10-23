#!/bin/sh
# audreyt/pi-ds4 model download.
#
# Fetches the DeepSeek V4.1 Flash 1017 Maya-XS abliterated language GGUF and the
# matching 1017 vision sidecar, then symlinks ./ds4flash.gguf to the language
# file (resumable via curl -C -).
#
#   language: audreyt/DeepSeek-V4.1-Flash-Abliterated-GGUF
#             DeepSeek-V4.1-Flash-1017-Maya-XS-Abliterated.gguf
#             365713686528 bytes (~340.6 GiB on disk). About 107.35 GiB of it is
#             kept resident on Metal; the Engram tables are read from disk.
#   vision:   audreyt/deepseek-v4.1-flash-1017-gguf
#             DeepSeek-V4.1-Flash-1017-Vision.gguf
#             970555552 bytes
#
# Maya-XS needs a 128 GB Mac and runs fully resident (no --ssd-streaming).
# ds4-server must be started with
# --vision gguf/DeepSeek-V4.1-Flash-1017-Vision.gguf.
#
# After the new pair passes size checks and ./ds4flash.gguf is switched, the
# v0.6 Vision-Exp IQ2 language GGUF and V4 encoder are removed, along with any
# leftover v0.5 Headroom128 files. Nothing is deleted before that, so a failed
# fetch keeps the working older model.
#
# Fresh language downloads are SHA-256 checked. A matching hash receipt and
# size let subsequent launches refresh the symlink without rehashing 341 GiB.
# Run from the ds4 support checkout
# (cwd = ~/.pi/ds4/support).
#
# Usage: download_model.sh [maya-xs|q1|preferred]
#   maya-xs    DeepSeek V4.1 Flash 1017 Maya-XS abliterated + vision (default)
#   q1         retained alias for existing configurations
#   preferred  alias for maya-xs
set -eu

QUANT="${1:-maya-xs}"
if [ "$QUANT" = "preferred" ] || [ "$QUANT" = "q1" ] || [ "$QUANT" = "ds41f-q1-abliterated" ]; then
    QUANT="maya-xs"
fi

if [ "$QUANT" != "maya-xs" ]; then
    echo "pi-kami automates DeepSeek V4.1 Flash 1017 Maya-XS abliterated (selector: maya-xs; aliases: q1, preferred)." >&2
    echo "The V4 Vision-Exp IQ2 (selector q2) was pi-ds4 v0.6.x. To run another GGUF, start ds4-server manually (see README)." >&2
    echo "Requested quant: $QUANT" >&2
    exit 1
fi

LANG_REPO="audreyt/DeepSeek-V4.1-Flash-Abliterated-GGUF"
LANG_REV="89cba799fcddca88bde8c8cfa8006d28dbf8dc79"
LANG_FILE="DeepSeek-V4.1-Flash-1017-Maya-XS-Abliterated.gguf"
LANG_BYTES=365713686528
LANG_SHA256="f414995b3797f77009634fac995f50834e70393771f9423fca984c892503b42a"
ENC_REPO="audreyt/deepseek-v4.1-flash-1017-gguf"
ENC_REV="5ab6e05050613bf0dfcfb48426d3aaa4cb422cd0"
ENC_FILE="DeepSeek-V4.1-Flash-1017-Vision.gguf"
ENC_BYTES=970555552

OUT_DIR="./gguf"
SRC_PATH="$OUT_DIR/$LANG_FILE"
ENC_PATH="$OUT_DIR/$ENC_FILE"
LINK_PATH="./ds4flash.gguf"
HASH_PATH="$SRC_PATH.sha256"

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

language_verified() {
    [ -s "$SRC_PATH" ] && [ "$(file_size "$SRC_PATH")" = "$LANG_BYTES" ] || return 1
    if [ -r "$HASH_PATH" ]; then
        IFS= read -r verified_hash < "$HASH_PATH" || return 1
        [ "$verified_hash" = "$LANG_SHA256" ] && return 0
    fi
    actual_hash=$(shasum -a 256 "$SRC_PATH" | awk '{print $1}')
    [ "$actual_hash" = "$LANG_SHA256" ] || return 1
    printf '%s\n' "$LANG_SHA256" > "$HASH_PATH"
}

# Bytes still to fetch for one file: 0 when complete, else what the resumable
# .part is missing.
remaining_bytes() {
    path="$1"
    bytes="$2"
    if [ -s "$path" ] && [ "$(file_size "$path")" = "$bytes" ]; then
        echo 0
    elif [ -e "$path.part" ]; then
        echo $((bytes - $(file_size "$path.part")))
    else
        echo "$bytes"
    fi
}

# The older model stays until the new pair verifies, so check for the whole
# download up front, with 2 GiB to spare.
LANG_READY=0
if language_verified; then
    LANG_READY=1
    language_need=0
elif [ -e "$SRC_PATH.part" ]; then
    language_need=$((LANG_BYTES - $(file_size "$SRC_PATH.part")))
    if [ "$language_need" -lt 0 ]; then
        echo "ds4 download: language partial file is larger than the pinned artifact" >&2
        exit 1
    fi
else
    language_need="$LANG_BYTES"
fi
need=$((language_need + $(remaining_bytes "$ENC_PATH" "$ENC_BYTES")))
if [ "$need" -gt 0 ]; then
    avail=$(( $(df -k "$OUT_DIR" | awk 'NR == 2 {print $4}') * 1024 ))
    if [ "$avail" -lt $((need + 2147483648)) ]; then
        echo "ds4 download: need $((need / 1073741824)) GiB free in $OUT_DIR plus 2 GiB headroom; $((avail / 1073741824)) GiB available." >&2
        echo "Free space (the v0.6 Vision-Exp files in $OUT_DIR are about 82 GiB) and run again." >&2
        exit 1
    fi
fi

if [ "$LANG_READY" = 1 ]; then
    echo "ds4 download: language GGUF already present ($SRC_PATH)"
else
    echo "ds4 download: fetching Maya-XS abliterated $LANG_FILE (~340.6 GiB, one-time, resumable)..."
    URL="https://huggingface.co/$LANG_REPO/resolve/$LANG_REV/$LANG_FILE"
    curl_hf "$SRC_PATH.part" "$URL"
    if [ "$(file_size "$SRC_PATH.part")" != "$LANG_BYTES" ]; then
        echo "ds4 download: language GGUF size $(file_size "$SRC_PATH.part") != $LANG_BYTES" >&2
        exit 1
    fi
    actual_hash=$(shasum -a 256 "$SRC_PATH.part" | awk '{print $1}')
    if [ "$actual_hash" != "$LANG_SHA256" ]; then
        echo "ds4 download: language SHA-256 mismatch; previous model remains active" >&2
        exit 1
    fi
    mv "$SRC_PATH.part" "$SRC_PATH"
    printf '%s\n' "$LANG_SHA256" > "$HASH_PATH"
fi

if [ -s "$ENC_PATH" ] && [ "$(file_size "$ENC_PATH")" = "$ENC_BYTES" ]; then
    echo "ds4 download: vision sidecar already present ($ENC_PATH)"
else
    if [ -e "$ENC_PATH" ]; then
        echo "ds4 download: removing size-mismatched vision sidecar ($(file_size "$ENC_PATH") != $ENC_BYTES)" >&2
        rm -f "$ENC_PATH"
    fi
    echo "ds4 download: fetching V4.1 vision sidecar $ENC_FILE (~926 MiB, one-time, resumable)..."
    URL="https://huggingface.co/$ENC_REPO/resolve/$ENC_REV/$ENC_FILE"
    curl_hf "$ENC_PATH.part" "$URL"
    mv "$ENC_PATH.part" "$ENC_PATH"
    if [ "$(file_size "$ENC_PATH")" != "$ENC_BYTES" ]; then
        echo "ds4 download: vision sidecar size $(file_size "$ENC_PATH") != $ENC_BYTES" >&2
        exit 1
    fi
fi

echo "ds4 download: vision sidecar ready (server must run with --vision gguf/$ENC_FILE)"

ln -sfn "gguf/$LANG_FILE" "$LINK_PATH"
echo "ds4 download: ./ds4flash.gguf -> gguf/$LANG_FILE"

# Only after both size checks and the ds4flash symlink switch.
# Deleting first would leave a failed download with no working model.
if [ -s "$SRC_PATH" ] && [ "$(file_size "$SRC_PATH")" = "$LANG_BYTES" ] \
    && [ -s "$ENC_PATH" ] && [ "$(file_size "$ENC_PATH")" = "$ENC_BYTES" ]; then
    for obsolete in \
        "$OUT_DIR/DeepSeek-V4-Flash-Vision-Exp-Abliterated-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf" \
        "$OUT_DIR/DeepSeek-V4-Flash-Vision-Exp-Abliterated-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8.gguf.part" \
        "$OUT_DIR/DeepSeek-V4-Flash-Vision-Encoder.gguf" \
        "$OUT_DIR/DeepSeek-V4-Flash-Vision-Encoder.gguf.part" \
        "$OUT_DIR/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128.gguf" \
        "$OUT_DIR/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128.gguf.part" \
        "$OUT_DIR/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128-DSpark-support.gguf" \
        "$OUT_DIR/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128-DSpark-support.gguf.part"
    do
        if [ -e "$obsolete" ]; then
            echo "ds4 download: removing obsolete earlier artifact $obsolete"
            rm -f "$obsolete"
        fi
    done
fi
