# pi-ds4 — managed local DeepSeek V4 Flash for pi (audreyt fork)

> 👉 [**完整指南 / Full guide: pi.audreyt.org**](https://pi.audreyt.org/)

![abliteration demo](demo.gif)

`pi-ds4` is a [pi](https://github.com/earendil-works/pi) provider extension that
turns [audreyt/ds4](https://github.com/audreyt/ds4) into an on-demand local
backend for `ds4/deepseek-v4-flash`. It is a personal fork of
[mitsuhiko/pi-ds4](https://github.com/mitsuhiko/pi-ds4): same lease / watchdog /
on-demand server UX, different engine pin, preferred GGUF, and steering defaults.

**Primary supported managed path today: Apple Silicon (Metal), ≥96 GB unified
RAM.** Linux CUDA and AMD ROCm are real `audreyt/ds4` backends. The extension
selects the Makefile’s product targets (`cuda-spark`, `cuda CUDA_ARCH=…`,
`strix-halo`) instead of bare `make ds4-server` — but a correct CUDA install still
needs a working `nvidia-smi`, matching toolkit, and a post-build generation smoke
check. Until you have verified that path on your box, prefer
bring-your-own-binary on NVIDIA hosts (see below).

## Install

```sh
pi remove   https://github.com/mitsuhiko/pi-ds4   # if you had the upstream extension
pi install  https://github.com/audreyt/pi-ds4
```

### What GitHub serves today (tag `v0.6.1`)

| Item | Value |
|---|---|
| Package version | **0.6.1** |
| `SUPPORT_PIN` | `7855b7a` (`audreyt/ds4` main: Vision-Exp engine + `preferred` alias; `--vision` works) |
| Preferred GGUF | Vision-Exp abliterated IQ2 from [`audreyt/DeepSeek-V4-Flash-Vision-Exp-Abliterated-GGUF`](https://huggingface.co/audreyt/DeepSeek-V4-Flash-Vision-Exp-Abliterated-GGUF) plus the unmodified encoder from [`antirez/deepseek-v4-gguf`](https://huggingface.co/antirez/deepseek-v4-gguf) — `preferred` alias now accepted (`q2`/`preferred`) |
| Default context | 100 k tokens (`DS4_CONTEXT_KB=100`) |
| Guide / OG card | **v0.6.1** Vision-Exp (~81 GiB IQ2 + encoder; 286/45 t/s is a 207-token `/read` smoke, not a 2k prefill bench) |

`pi install https://github.com/audreyt/pi-ds4` installs exactly this tag.

### Fork-specific behaviour (vs mitsuhiko/pi-ds4)

1. **Pulls [`audreyt/ds4`](https://github.com/audreyt/ds4) at a pinned commit**
   (`SUPPORT_PIN`), not floating `antirez/ds4` `main`. The pin is enforced on
   launch: mismatch → fetch + hard reset + delete cached binaries so they rebuild.
2. **Ships its own `download_model.sh`** for the preferred Vision-Exp language
   GGUF (~80.76 GiB) plus the 889 MiB encoder, language file symlinked as
   `ds4flash.gguf`. `ds4-server` / `ds4-agent` are started with `--vision`.
3. **No 0731 DSpark attach.** That support GGUF is a different Flash checkpoint.
   Directional steering stays off by default until a Vision-Exp-matched vector
   is validated. Opt-in via env (below).

### Requirements by platform

| Platform | Managed `pi install` | Notes |
|---|---|---|
| Apple Silicon, 128 GB+ | Yes | Preferred path. |
| Apple Silicon, 96–127 GB | Yes after wired-limit raise | `sudo sysctl iogpu.wired_limit_mb=92000` (persist via `/etc/sysctl.conf`). |
| Apple Silicon, &lt;96 GB | No | Extension refuses; Vision-Exp IQ2 footprint. |
| Linux + NVIDIA | Auto-selects Makefile CUDA targets | Needs `nvidia-smi` + `nvcc`. GB10 / sm_121 → `make cuda-spark`. Post-build **generation smoke** must pass. |
| Linux + AMD Strix Halo (gfx1151) | Auto-selects `make strix-halo` when no NVIDIA device and `hipcc` exists | Or force `DS4_BACKEND=rocm`. |
| CPU-only | Opt-in only | `DS4_ALLOW_CPU=1` or `DS4_BACKEND=cpu`. Not silent fallback. |

**Disk (managed Vision-Exp):** language 86720111776 B + encoder 932857760 B = 87652969536 B (~81.63 GiB / 87.653 GB). Fresh install: plan ≥ ~88 GB plus KV. A v0.5.x upgrade keeps the old Headroom128 language GGUF (~87 GB) and optional 0731 DSpark (5989114272 B, ~5.6 GiB / ~5.99 GB) until the new pair passes size checks and *then* `ds4flash.gguf` is switched. Peak occupancy: ~175 GB without DSpark, ~181 GB with DSpark. After the switch, `download_model.sh` deletes those obsolete files. To free space *before* the fetch (this destroys the working 0731 model):

```sh
rm -f ~/.pi/ds4/support/gguf/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128.gguf \
      ~/.pi/ds4/support/gguf/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128.gguf.part \
      ~/.pi/ds4/support/gguf/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128-DSpark-support.gguf \
      ~/.pi/ds4/support/gguf/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128-DSpark-support.gguf.part
```

### What first launch does

1. Clone `audreyt/ds4` at `SUPPORT_PIN` into `~/.pi/ds4/support/` (or hard-reset an
   existing checkout to the pin and delete cached `ds4-server` / `ds4-agent`).
2. **Select a build plan and run the matching `make` target** (see table below).
3. Run bundled `download_model.sh` for the Vision-Exp language GGUF + encoder.
4. On non-Metal backends, run a **generation smoke test** (asserts non-empty
   `choices[0].message.content` — not merely HTTP 200) with `--vision`.
5. Spawn `ds4-server --vision gguf/DeepSeek-V4-Flash-Vision-Encoder.gguf` on
   `127.0.0.1:8000` and register `ds4/deepseek-v4-flash`.

Subsequent launches are idempotent when the pin, build plan, and GGUF already match.

### Build target selection

The extension calls **ds4 Makefile product targets**. It does not re-encode nvcc
`-gencode` tables. Mapping:

| Detection | `make` invocation |
|---|---|
| macOS (default) | `make ds4-server` (Metal); `make ds4-agent` when needed |
| `nvidia-smi` compute_cap `12.1` / name GB10·Spark | `make cuda-spark` → `CUDA_ARCH=sm_121` (+ MXFP4 gencode in ds4) |
| Other single NVIDIA cap `M.N` | `make cuda CUDA_ARCH=sm_MN` |
| `DS4_CUDA_ARCH=sm_XX` / `native` | `make cuda CUDA_ARCH=…` or `make cuda-generic` |
| No NVIDIA, `hipcc` present | `make strix-halo` |
| `DS4_ALLOW_CPU=1` | `make cpu` |
| Unknown / mixed caps / no smi | **Fail loud** with remediation — never bare `make ds4-server` on Linux |

Last plan is recorded in `~/.pi/ds4/build.json`. If the selected plan changes,
the extension runs `make clean` before rebuilding so stale arch-less objects
cannot survive into a new link.

Overrides: `DS4_BUILD_TARGET`, `DS4_CUDA_ARCH`, `DS4_BACKEND`,
`DS4_CUDA_ALLOW_NATIVE=1`, `DS4_ALLOW_CPU=1`, `DS4_SKIP_BUILD_SMOKE=1` (dev only).

### Wrong-arch / degenerate CUDA output (read this)

A mis-targeted CUDA binary often **starts fine**, serves `/v1/models`, and even
returns HTTP 200 chat completions — with **empty** `choices[0].message.content`,
generation stuck in THINKING, or early death on a repetition guard (`ngram=…`).
The same weights + source on Metal produce full prose.

That is a **build-target bug**, not a “model quality” mystery. Fix:

```sh
rm -f ~/.pi/ds4/support/ds4-server ~/.pi/ds4/support/ds4-agent ~/.pi/ds4/build.json
# On GB10 / DGX Spark:
#   cd ~/.pi/ds4/support && make clean && make cuda-spark
# Or set DS4_CUDA_ARCH / DS4_BUILD_TARGET and relaunch pi so the extension rebuilds.
```

The managed path’s post-build smoke is meant to catch this before you chat.

### Bring-your-own binary (recommended when debugging CUDA)

```sh
git clone https://github.com/audreyt/ds4 && cd ds4
git checkout <pin>   # e.g. published d0c2b43
make cuda-spark      # or: make cuda CUDA_ARCH=sm_90 / make strix-halo

export DS4_RUNTIME_DIR=/path/to/that/checkout
# or: ./install-pi-extension-local.sh /path/to/that/checkout
```

With `DS4_RUNTIME_DIR` set, the extension will not delete your binaries to force
a retarget.

### What landed in v0.5.4 (patch, 2026-08)

* **Engine pin `67acbd8`** — fixes the `client_main` self-deadlock introduced in `057f62f` (double-lock of `j.mu` stalled every HTTP request); still carries PR #755 Metal decode fusions + truncated DSML tool recovery.
* **Platform-aware build + generation smoke:** `Darwin → make ds4-server`; `GB10/sm_121 → make cuda-spark`; other single caps `→ make cuda CUDA_ARCH=…`; no NVIDIA + `hipcc → make strix-halo`; unknown/mixed → fail loud (no arch-less binary). After weights land, non-Metal builds run a generation smoke requiring non-empty `choices[0].message.content`.
* **Managed DSpark on by default when present:** `download_model.sh` best-effort fetches the matching Headroom128 DSpark support GGUF (~5.6 GiB, same `apetersson/Headroom128` repo); `ds4-server` starts with `--dspark --mtp gguf/…` when the file is present. Set `DS4_DSPARK=0` to skip the fetch and run plain decode. **No performance claim** — re-measure on a correct `cuda-spark`/Metal binary.

### Benchmarks — what we will and will not claim

| Claim | Status |
|---|---|
| v0.5.4 M5 Max ~622 t/s prefill / ~42 t/s gen @ 2k Headroom128 | Published Metal bench on `67acbd8` (same fusions as `e4812d8`) |
| Any DSpark drafter tok/s or “+N%” figure | **Not claimed** — prior numbers void; re-measure on a correct build |
| CUDA GB10 tokens/s after `cuda-spark` | **Unverified on this README surface** — measure before claiming |

## Local development install

```sh
./install-pi-extension-local.sh /path/to/audreyt-ds4-checkout
```

If `~/.pi/ds4/support` already exists, pass `--force` to move it aside and
symlink your checkout. GGUFs are preserved when possible (APFS clone-on-write on
macOS). Restart `pi` or run `/reload`.

## What the upstream extension does (and this fork preserves)

Everything the [upstream `mitsuhiko/pi-ds4`](https://github.com/mitsuhiko/pi-ds4)
README documents still applies:

* On-demand `ds4-server` via per-process leases in `~/.pi/ds4/clients/<pid>.json`,
  with bundled `ds4-watchdog.sh` when no leases remain.
* Shared inference backend across `pi` processes.
* Logs at `~/.pi/ds4/log`; KV disk cache at `~/.pi/ds4/kv` (RAM-tiered default when
  `DS4_KV_DISK_SPACE_MB` is unset: 64 GB on 128 GB+ Macs, 32 GB on 96–127 GB,
  else 8 GB).
* `/ds4` shows the live log; `/ds4-agent` launches the native agent TUI.

## Native ds4-agent foreground mode

`ds4-agent` is not an HTTP provider. It is a native terminal application with
its own session loop and tools. Supported integration:

```text
/ds4-agent
```

The extension prepares the runtime, builds `ds4-agent` if needed (same plan as
the server), ensures the GGUF, waits for Pi to go idle, then yields the terminal.
Type `/quit` inside `ds4-agent` to return. An idle managed `ds4-server` is stopped
first so the model is not loaded twice; other leases or HTTP clients cause a
refusal instead of a kill.

## Runtime layout

Under `~/.pi/ds4`:

* `support/` — shallow checkout of `audreyt/ds4` at `SUPPORT_PIN`
* `support/gguf/` — downloaded GGUF(s)
* `support/ds4flash.gguf` — symlink consumed by `ds4-server`
* `build.json` — last successful build plan (key, make args, pin, smoke preview)
* `kv/` — on-disk KV cache
* `clients/` — active pi process leases
* `agent.json` — foreground `ds4-agent` guard
* `log` — build / download / server / smoke / watchdog log

## Directional steering

The engine supports runtime
[directional steering](https://github.com/audreyt/ds4/blob/main/dir-steering/README.md).
`audreyt/ds4` still ships the historical `uncertainty_ablit_imatrix.f32` vector
(CyberNeurova-calibrated). **Default on Vision-Exp: off**
(`DS4_DIR_STEERING_FFN=0`, `DS4_DIR_STEERING_ATTN=0`).

Opt in for research:

```sh
export DS4_DIR_STEERING_FILE=dir-steering/out/uncertainty_ablit_imatrix.f32
export DS4_DIR_STEERING_FFN=-0.75
export DS4_DIR_STEERING_ATTN=0
export DS4_DIR_STEERING_POLICY=final-answer
```

![uncertainty demo](uncertainty.gif)

Guarded magnitude on the historical vector is `ffn=-0.75, attn=0`. Stronger
settings can leak into tool-call grammar on long agent prompts. Reproducibility
uses seed `42` by default (`DS4_REPRODUCIBLE=1`) and deterministic tool-call IDs
from seeded requests on audreyt/ds4.

## Configuration

* `DS4_SUPPORT_REPO` — git URL (default `https://github.com/audreyt/ds4`)
* `DS4_SUPPORT_BRANCH` — branch when cloning (default `main`)
* `DS4_SUPPORT_PIN` — exact commit to enforce; set **empty** to disable pin reset
* `DS4_PROTOCOL` — `openai` (default), `openai-responses`, or `anthropic`
* `DS4_BUILD_TARGET` — raw `make` args override (e.g. `cuda-spark`, `strix-halo`)
* `DS4_CUDA_ARCH` — e.g. `sm_90`, `sm_121`, `native`
* `DS4_BACKEND` — `metal` / `cuda` / `rocm` / `cpu`
* `DS4_CUDA_ALLOW_NATIVE` — opt-in `make cuda-generic`
* `DS4_ALLOW_CPU` — opt-in CPU fallback when no GPU backend is detected
* `DS4_SKIP_BUILD_SMOKE` — skip post-build generation smoke (dev only; default off)
* `DS4_DOWNLOAD_SCRIPT` — absolute path to model download script
* `DS4_REPRODUCIBLE` / `DS4_REPRODUCIBLE_SEED` — seed injection (default on / `42`)
* `DS4_CONTEXT_KB` — context kilotokens (default `100`)
* `DS4_KV_DISK_SPACE_MB` — KV disk budget (RAM-tiered default when unset)
* `DS4_DIR_STEERING_FILE` / `_FFN` / `_ATTN` / `_POLICY` — steering controls
* `DS4_RUNTIME_DIR` — use an existing ds4 checkout; do not clobber its binaries
* `DS4_SERVER_BINARY` / `DS4_AGENT_BINARY` — custom binary paths
* `DS4_AGENT_TOKENS` / `DS4_AGENT_THINK` / `DS4_AGENT_SYSTEM` / `DS4_AGENT_TRACE`
* `DS4_MODEL_QUANT` — must be `q2` (historic selector) or `preferred` (alias) or unset; other values error — both select the abliterated Vision-Exp IQ2 + encoder
* `DS4_READY_TIMEOUT_MS` — server ready timeout
* `DS4_WATCHDOG_SCRIPT` — absolute path to the watchdog; default bundled `ds4-watchdog.sh`
* `HF_TOKEN` — passed through for HuggingFace downloads

## Known gaps

* **No automated test in this repo** spawns `ds4-server` and exercises
  `/v1/chat/completions` with large tool schemas. Tool-call quality lives in
  `audreyt/ds4` (`test_tool_call_quality`) and live agent runs. The build smoke
  only checks short non-empty prose on non-Metal backends.
* **CUDA and DSpark performance** are not claimed here until measured on a
  correctly targeted binary (both require `make cuda-spark` / correct arch).

## What's new

### Published v0.6.1 (`d0c2b43` pin + `7855b7a` ds4, 2026-09-02)

Patch: `download_model.sh` and `DS4_MODEL_QUANT` now accept `preferred` as an alias to the historic `q2` selector — both map to the same Vision-Exp abliterated IQ2 + encoder pair. `audreyt/ds4` `preferred` default now also fetches that pair (so `pi` and bare `ds4` agree). No engine or weight change; `d0c2b43` engine + `367a1fef`/`f71f23d` GGUFs unchanged.

### Published v0.6.0 (`d0c2b43` pin, 2026-09-01)

Managed preferred model cuts over from Headroom128 0731 Flash to **Vision-Exp
abliterated IQ2** (`audreyt/DeepSeek-V4-Flash-Vision-Exp-Abliterated-GGUF` @
`367a1fef`, official 80.76 GiB recipe with 33 grafted `attn_output_b` Q8_0
payloads) plus the unmodified 316-tensor encoder (`antirez/deepseek-v4-gguf` @
`f71f23d`). Pair sum 87652969536 B (~81.63 GiB / 87.653 GB). Engine pin
`d0c2b43` (Vision-Exp `--vision`). `ds4-server` and `ds4-agent` start with
`--vision` and advertise `input: text+image`. No 0731 DSpark attach.
`download_model.sh` pins both HF URLs to those commits (not `/resolve/main/`),
and switches `ds4flash.gguf` / deletes the four 0731 Headroom128/DSpark names
only after both size checks. M5 Max smoke on the grafted sibling: `/read
earth.jpg` (207 input tokens, `--ctx 2048`) 285.75 prefill / 44.94 gen t/s —
not a 2k-token prefill bench.

### Published v0.5.4 (`67acbd8` pin, 2026-08)

v0.5.4 advances the `audreyt/ds4` pin to `67acbd8` — fixing the `client_main`
self-deadlock introduced in `057f62f` — while retaining PR #755 Metal decode
optimizations (pre-M5/M5 Q2 + MXFP4), long-context inverse-RoPE/top-k fix,
truncated DSML tool-call recovery inside unclosed thinking, and OpenAI
tool-schema JSON spelling. Platform-aware Makefile targets and the managed DSpark
support fetch (default-on when present; `DS4_DSPARK=0` disables) also land here
but carry no perf claim until re-measured on a correct `cuda-spark` binary.
Preferred Headroom128 and the conservative 100 k default context are unchanged.
M5 Max re-validated at about 622 t/s prefill and 42 t/s generation at 2k context.

### Published v0.5.3 (`e4812d8` pin, 2026-08)

v0.5.3 advanced the pin to `e4812d8` (PR #755 merge) with the same 622/42 M5 Max
headlines.

### Earlier 0.5.x

* **v0.5.2 (`a768f37`)** — Metal MoE/indexed prefill, MXFP4/CUDA mmq, tool-in-think
  recovery; contemporaneous M5 Max notes ~638 t/s prefill / ~37 t/s gen @ 2k.
* **v0.5.1** — thinking-level map: `off→none`, `high→high`, `max→max`; intermediate
  levels unavailable instead of silent collapse.
* **v0.5.0** — managed preferred model cut over to Headroom128; steering default off.

Engine features available when the pinned ds4 tree includes them (not all are
flags the extension passes by default): `/health`+`/stats`, agent-loop KV
improvements, disconnect cancel, exact-DSML replay fixes. Opt-in by hand when
running `ds4-server` yourself: `--ssd-streaming`, MTP/DSpark flags, `--max-queue`,
distributed / ROCm workflows documented upstream in audreyt/ds4.

## Acknowledgements

* **[mitsuhiko/pi-ds4](https://github.com/mitsuhiko/pi-ds4)** — upstream extension;
  lifecycle / watchdog / lease machinery is Armin Ronacher's work.
* **[antirez/ds4](https://github.com/antirez/ds4)** — DeepSeek V4 Flash engine.
* **[ivanfioravanti's PR #15](https://github.com/antirez/ds4/pull/15)** and the
  wider 2026 engine round (SSD streaming, distributed inference, ROCm, DSpark,
  observability).
* **[@tjansn](https://x.com/thomasjansn)** — KV disk cap pain on long agent sessions.
* **The cyberneurova research project** — abliterated GGUFs that motivated this fork.

## License

MIT, matching upstream. See `LICENSE`.
