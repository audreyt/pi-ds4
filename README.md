# pi-ds4 — managed local DeepSeek V4 Flash for pi (audreyt fork)

> 👉 [**完整指南 / Full guide: pi.audreyt.org**](https://pi.audreyt.org/)

![abliteration demo](demo.gif)

`pi-ds4` is a [pi](https://github.com/earendil-works/pi) provider extension that
turns [audreyt/ds4](https://github.com/audreyt/ds4) into an on-demand local
backend for `ds4/deepseek-v4-flash`. It is a personal fork of
[mitsuhiko/pi-ds4](https://github.com/mitsuhiko/pi-ds4): same lease / watchdog /
on-demand server UX, different engine pin, preferred GGUF, and steering defaults.

**Primary supported managed path today: Apple Silicon (Metal), ≥96 GB unified
RAM.** Linux CUDA and AMD ROCm are real `audreyt/ds4` backends. The extension now
selects the Makefile’s product targets (`cuda-spark`, `cuda CUDA_ARCH=…`,
`strix-halo`) instead of bare `make ds4-server` — but a correct CUDA install still
needs a working `nvidia-smi`, matching toolkit, and a post-build generation smoke
check. Until you have verified that path on your box, prefer
bring-your-own-binary on NVIDIA hosts (see below).

## Published install (what GitHub serves today)

```sh
pi remove   https://github.com/mitsuhiko/pi-ds4   # if you had the upstream extension
pi install  https://github.com/audreyt/pi-ds4
```

**Published contract (`origin/main`, tag `v0.5.3`):**

| Item | Value |
|---|---|
| Package version | **0.5.3** |
| `SUPPORT_PIN` | `e4812d8` (PR #755 Metal decode work + truncated DSML tool recovery) |
| Preferred GGUF | Headroom128 abliterated 0731 from [`apetersson/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128`](https://huggingface.co/apetersson/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128) |
| Default context | 100 k tokens (`DS4_CONTEXT_KB=100`) |
| Guide / OG card | Describe **v0.5.3** headlines |

Local `main` may already carry unreleased 0.6.0 work (DSpark default + newer pin).
That is **not** what `pi install https://github.com/audreyt/pi-ds4` gets until it
is pushed. See [Unreleased on local main](#unreleased-on-local-main).

### Fork-specific behaviour (vs mitsuhiko/pi-ds4)

1. **Pulls [`audreyt/ds4`](https://github.com/audreyt/ds4) at a pinned commit**
   (`SUPPORT_PIN`), not floating `antirez/ds4` `main`. The pin is enforced on
   launch: mismatch → fetch + hard reset + delete cached binaries so they rebuild.
2. **Ships its own `download_model.sh`** for the preferred Headroom128 GGUF
   (~81 GiB / ~87 GB), symlinked as `ds4flash.gguf`.
3. **Directional steering stays off by default** on Headroom128 until a
   weight-matched vector is validated. Opt-in via env (below).

### Requirements by platform

| Platform | Managed `pi install` | Notes |
|---|---|---|
| Apple Silicon, 128 GB+ | Yes | Preferred path. |
| Apple Silicon, 96–127 GB | Yes after wired-limit raise | `sudo sysctl iogpu.wired_limit_mb=92000` (persist via `/etc/sysctl.conf`). |
| Apple Silicon, &lt;96 GB | No | Extension refuses; Headroom128 footprint. |
| Linux + NVIDIA | Auto-selects Makefile CUDA targets | Needs `nvidia-smi` + `nvcc`. GB10 / sm_121 → `make cuda-spark`. Post-build **generation smoke** must pass. |
| Linux + AMD Strix Halo (gfx1151) | Auto-selects `make strix-halo` when no NVIDIA device and `hipcc` exists | Or force `DS4_BACKEND=rocm`. |
| CPU-only | Opt-in only | `DS4_ALLOW_CPU=1` or `DS4_BACKEND=cpu`. Not silent fallback. |

**Disk (managed Headroom128):** plan ≥ ~90 GB free for the main GGUF. Unreleased
0.6.0 also fetches ~5.6 GiB DSpark support when enabled.

### What first launch does

1. Clone `audreyt/ds4` at `SUPPORT_PIN` into `~/.pi/ds4/support/` (or hard-reset an
   existing checkout to the pin and delete cached `ds4-server` / `ds4-agent`).
2. **Select a build plan and run the matching `make` target** (see table below).
3. Run bundled `download_model.sh` for Headroom128.
4. On non-Metal backends, run a **generation smoke test** (asserts non-empty
   `choices[0].message.content` — not merely HTTP 200).
5. Spawn `ds4-server` on `127.0.0.1:8000` and register `ds4/deepseek-v4-flash`.

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
git checkout <pin>   # e.g. published e4812d8, or newer when you intend it
make cuda-spark      # or: make cuda CUDA_ARCH=sm_90 / make strix-halo

export DS4_RUNTIME_DIR=/path/to/that/checkout
# or: ./install-pi-extension-local.sh /path/to/that/checkout
```

With `DS4_RUNTIME_DIR` set, the extension will not delete your binaries to force
a retarget.

## Unreleased on local main

Local commits ahead of `origin/main` (not what GitHub `pi install` gets):

- **v0.6.0 intent** — default DSpark support download + `--dspark --mtp` when the
  support GGUF is present; `package.json` may read `0.6.0` locally.
- **Pin `67acbd8`** — fixes a `client_main` request-enqueue self-deadlock in
  `057f62f`, and carries PR #755 DSML tool-call recovery under large schemas.
- **Platform-aware `ensureBuilt`** — Makefile target selection + non-Metal
  generation smoke + `build.json` (this document’s build section).

**Do not treat the above as shipped.** `5192a34` (pin bump alone) is unsafe to
publish without the build-selection commit: the pin deletes binaries and would
have force-rebuilt CUDA hosts through bare `make ds4-server`. Those changes must
ship together.

### Benchmarks — what we will and will not claim

| Claim | Status |
|---|---|
| v0.5.3 M5 Max ~622 t/s prefill / ~42 t/s gen @ 2k Headroom128 | Published-era Metal bench language tied to the v0.5.3 pin / guide |
| DSpark “~45→50 t/s” acceptance fixture | **Unreleased / local only** — not a GitHub-install guarantee |
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
(CyberNeurova-calibrated). **Default on Headroom128: off**
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
* `DS4_DSPARK` — DSpark on managed path (default on in unreleased 0.6.0; published
  0.5.3 behaviour follows that release’s code)
* `DS4_RUNTIME_DIR` — use an existing ds4 checkout; do not clobber its binaries
* `DS4_SERVER_BINARY` / `DS4_AGENT_BINARY` — custom binary paths
* `DS4_AGENT_TOKENS` / `DS4_AGENT_THINK` / `DS4_AGENT_SYSTEM` / `DS4_AGENT_TRACE`
* `DS4_MODEL_QUANT` — must be `q2` (historic selector) or unset; other values error
* `DS4_READY_TIMEOUT_MS` — server ready timeout
* `HF_TOKEN` — passed through for HuggingFace downloads

## Known gaps

* **No automated test in this repo** spawns `ds4-server` and exercises
  `/v1/chat/completions` with large tool schemas. Tool-call quality lives in
  `audreyt/ds4` (`test_tool_call_quality`) and live agent runs. The new build
  smoke only checks short non-empty prose on non-Metal backends.
* **Guide (`index.html`) / OG image** still describe published **v0.5.3** while a
  local tree may show `package.json` `0.6.0`. Refresh them in the same release
  train as the GitHub push.
* **CUDA performance numbers** are not claimed here until measured on a
  correctly targeted `cuda-spark` (or explicit `CUDA_ARCH`) binary.

## What's new in published v0.5.3 (`e4812d8` pin, 2026-08)

v0.5.3 advances the `audreyt/ds4` pin to `e4812d8` (PR #755 Metal decode
optimizations for pre-M5/M5 Q2 + MXFP4, long-context inverse-RoPE/top-k fix,
truncated DSML tool-call recovery inside unclosed thinking, and OpenAI
tool-schema JSON spelling). Preferred Headroom128 and the conservative 100 k
default context are unchanged. Re-benched on Apple M5 Max with Headroom128:
about 622 t/s prefill and 42 t/s generation at 2k context.

### Earlier 0.5.x notes

* **v0.5.2 (`a768f37`)** — Metal MoE/indexed prefill, MXFP4/CUDA mmq, tool-in-think
  recovery; contemporaneous M5 Max notes ~638 t/s prefill / ~37 t/s gen @ 2k.
* **v0.5.1** — thinking-level map: `off→none`, `high→high`, `max→max`; intermediate
  levels unavailable instead of silent collapse.
* **v0.5.0** — managed preferred model cut over to Headroom128; steering default off.

Engine features available when the pinned ds4 tree includes them (not all are
flags the extension passes by default): `/health`+`/stats`, agent-loop KV
improvements, disconnect cancel, exact-DSML replay fixes. Opt-in by hand when
running `ds4-server` yourself: `--ssd-streaming`, experimental MTP/DSpark flags,
`--max-queue`, distributed / ROCm workflows documented upstream in audreyt/ds4.

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
