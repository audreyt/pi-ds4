# pi-ds4 — one-line install for personal frontier AI on Apple Silicon (audreyt fork)

> 👉 [**完整指南 / Full guide: pi.audreyt.org**](https://pi.audreyt.org/)

![abliteration demo](demo.gif)

This is a personal fork of [mitsuhiko/pi-ds4](https://github.com/mitsuhiko/pi-ds4),
Armin Ronacher's [pi](https://github.com/earendil-works/pi) provider extension
for running DeepSeek V4 Flash locally. It packages the engineering in
[audreyt/ds4](https://github.com/audreyt/ds4) into a one-line `pi install`,
so anyone with a 96 GB Apple Silicon Mac can run a frontier-class
284-billion-parameter MoE model end-to-end on their own laptop — no cloud
calls, no API costs, no per-token billing, no rate limits — with deterministic
seed-42 traces, stable generated tool-call IDs, and optional directional
steering for contested-question framing.

Same UX as upstream `mitsuhiko/pi-ds4` (one-line `pi install`, on-demand
`ds4-server`, per-process lease, watchdog shutdown), with three fork-specific
changes:

1. **Pulls [`audreyt/ds4`](https://github.com/audreyt/ds4) `main`** instead of
   `antirez/ds4` `main`. That branch has absorbed upstream DwarfStar work
   (Metal/CUDA/ROCm backends, native session batching, GLM 5.2, DSpark/MTP,
   distributed inference) and additionally keeps (a) deterministic tool-call
   ID derivation from seeded requests, which is what makes pi-ds4's `seed=42`
   traces stable end-to-end, (b) tool-safe `--dir-steering-policy final-answer`,
   (c) server observability + agent-loop cache robustness from antirez/ds4#489
   landed here ahead of upstream, and (d) the historical CyberNeurova research
   direction vector kept as an opt-in asset. See the
   [audreyt/ds4 README](https://github.com/audreyt/ds4#readme) for the full story.
2. **Ships its own `download_model.sh`** that shadows the antirez/ds4 one and
   fetches the preferred
   [Headroom128 GGUF](https://huggingface.co/apetersson/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128)
   (`DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128.gguf`, ~81 GiB / ~87 GB),
   then symlinks `ds4flash.gguf` to it. Matching optional DSpark support lives
   in the same HF repo as
   `DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128-DSpark-support.gguf`.
3. **Keeps directional steering available, but off by default** on Headroom128
   until a weight-matched direction is validated. The historical
   CyberNeurova-calibrated `uncertainty_ablit_imatrix.f32` remains in the ds4
   checkout for research use; set `DS4_DIR_STEERING_FFN=-0.75` (and optionally a
   different `DS4_DIR_STEERING_FILE`) to enable it. See
   [Directional steering](#directional-steering) below.

```sh
pi remove   https://github.com/mitsuhiko/pi-ds4   # if you had the upstream extension
pi install  https://github.com/audreyt/pi-ds4
```

On first launch, `pi` will:

1. Clone `audreyt/ds4` `main` into `~/.pi/ds4/support/`
2. `make ds4-server`
3. Run `download_model.sh`, which downloads:
   * `DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128.gguf` (~81 GiB / ~87 GB)
     from [`apetersson/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128`](https://huggingface.co/apetersson/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128)
   * symlink `ds4flash.gguf` to that file
4. Spawn `ds4-server` and register `ds4/deepseek-v4-flash` with `pi`.

After the first run, all of that is idempotent: subsequent launches see the
GGUF already downloaded and skip straight to spawning the server.

**Disk needed:** ~87 GB for the preferred Headroom128 GGUF (+ ~6 GB if you also
fetch the matching DSpark support file). Set `HF_TOKEN` if your HuggingFace
download benefits from auth.

## What's new in v0.5.1 (`a768f37` pin, 2026-08)

v0.5.1 keeps the preferred Headroom128 model and conservative 100 k default
context. The `audreyt/ds4` pin is now `a768f37` (merge of origin/main into
this fork on 2026-08-06: Metal MoE/indexed prefill accelerations, MXFP4/CUDA
mmq, Flash 0731 checkpointed vectors, and complete-tool recovery from unclosed
reasoning). It also corrects the provider's thinking-level contract to match
`ds4-server`'s actual modes: `off` → `none`, `high` → `high`, and `max` → `max`.
Unsupported intermediate levels are marked unavailable instead of silently
collapsing to `high`. `max` appears in pi 0.80.6+ and `ds4-server` requires at
least 393,216 context tokens for it, so set `DS4_CONTEXT_KB=394` or higher when
selecting it. Below that threshold, `ds4-server` safely uses ordinary `high`
thinking.

v0.5.0 cut the managed preferred model over to
[`apetersson/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128`](https://huggingface.co/apetersson/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128)
(single ~87 GB Headroom128 GGUF; optional matching DSpark support in the same
repo). Directional steering stays off by default until a Headroom128-calibrated
vector exists. Existing installs pick this up automatically on the next launch
when the extension refreshes the support pin and re-runs the bundled
downloader. The [guide's What's-new chapter](https://pi.audreyt.org/#whatsnew)
has the narrative version.

**On by default (managed path):**

* `GET /health` and `GET /stats` — liveness, queue depth, per-source KV-cache
  hit counters, token totals, last prefill/decode t/s; answered on the client
  thread even mid-generation (antirez/ds4#489, merged here ahead of upstream).
* Agent-loop KV-cache overhaul (same PR): snapshots stored on step thresholds,
  consumed snapshots deleted only after the tail prefill succeeds, eviction
  grace for fresh snapshots, visible checkpoints for chat/Anthropic tool-call
  turns. Long Claude Code / Codex sessions redo far less prefill.
* Disconnected clients cancel prefill and decode instead of wasting the GPU on
  a response nobody is waiting for.
* Exact-DSML tool-replay fidelity fixes (sampled whitespace separators,
  multi-invoke blocks, RAM-first replay-id lookups) — keeps seed-42 traces
  byte-stable.
* Hardened server JSON parsing; tool calls started inside an unclosed
  `<think>` are recovered; `ds4-agent` gains cooperative interruption, status
  polish, DSML-parsing hardening, an edit-tool fix with regression tests, and
  correct terminal restoration.

**In the engine, opt-in by hand** (run `ds4-server` yourself — see the guide's
§8.6; an adopted server only has the flags *you* give it, so re-pass the
steering flags):

* `--ssd-streaming` — routed MoE experts stream from SSD through an in-memory
  expert cache; upstream documents 64 GB Macs running the 2-bit Flash GGUF and
  128 GB Macs inspecting DeepSeek V4 Pro q2 this way.
* `--mtp DSpark.gguf` — experimental block-speculative decoding with the
  official DSpark draft head (convert with
  `gguf-tools/deepseek4-quantize --dspark-only`); this fork adds B2 rejection
  sampling (lossless — output distribution identical to the target), persisted
  RNG state, and `DS4_DSPARK_ADAPTIVE=1` adaptive block sizing. Measure with
  `DS4_MTP_TIMING=1` before trusting a speedup.
* `--max-queue N` — bounded request queue: 429 once N jobs wait; default 0
  keeps the old unbounded behavior.
* Correctness: the `--mtp-draft > 2` speculative-verify bug is fixed
  (antirez/ds4#358); `ds4-eval` multiple-choice grader false negatives are
  fixed with golden self-tests (antirez/ds4#319).

**Beyond the Mac (upstream):** a ROCm backend for AMD Strix Halo
(`make strix-halo`, walkthrough in `STRIXHALO.md`; prefer the plain
aligned-imatrix GGUF there), and distributed inference — the 4-bit Flash quant
across two 128 GB MacBooks over Thunderbolt 5, pipelined prefill faster than
one machine, generation slower.

## Local development install

If you have a checkout of this repo and a checkout of `audreyt/ds4` (or any
ds4 fork), wire `pi` to use them directly:

```sh
./install-pi-extension-local.sh /path/to/audreyt-ds4-checkout
```

If `~/.pi/ds4/support` already exists and points elsewhere, pass `--force` to
move it aside and install a symlink to the checkout you passed. Existing
`gguf/*.gguf` files (and resumable `.gguf.part` downloads) are preserved into
the new checkout first, using APFS clone-on-write copies on macOS when
available.

After install, restart `pi` or run `/reload`.

## What the upstream extension does (and this fork preserves)

Everything the [upstream `mitsuhiko/pi-ds4`](https://github.com/mitsuhiko/pi-ds4)
README documents still applies:

* On-demand `ds4-server` lifecycle managed via per-process leases in
  `~/.pi/ds4/clients/<pid>.json`, with a bundled `ds4-watchdog.sh` that stops
  the server when no leases remain.
* Single shared inference backend across all `pi` processes.
* Logs at `~/.pi/ds4/log`; KV disk cache at `~/.pi/ds4/kv` (RAM-tiered default when
  `DS4_KV_DISK_SPACE_MB` is unset: 64 GB on 128 GB+ Macs, 32 GB on 96–127 GB, else 8 GB;
  overridable via `DS4_KV_DISK_SPACE_MB`).
* `/ds4` inside `pi` shows the live ds4 log.
* `/ds4-agent` inside `pi` launches the native `ds4-agent` TUI in the same
  terminal, using the same checkout and GGUF.

The only differences are the fork-specific changes above: the ds4 source it
pulls, the model it downloads, and the steering defaults it applies.

## Native ds4-agent foreground mode

`ds4-agent` is not an HTTP provider. It is a native terminal application with
its own session loop, DSML tool engine, history, and on-disk KV state. That
means it cannot safely be hidden behind Pi's normal provider interface without
a stateful client/server protocol in ds4 itself.

The supported integration is therefore explicit:

```text
/ds4-agent
```

Run that slash command inside `pi` when you want the native form engine. The
extension prepares the shared runtime, builds `ds4-agent` if needed, ensures the
same GGUF is present, waits for Pi to become idle, then temporarily releases
Pi's TUI and lets `ds4-agent` own the terminal. Type `/quit` inside
`ds4-agent` to return to Pi.

To avoid loading the model twice, `/ds4-agent` will stop an idle
managed `ds4-server` before launching. If another Pi process or HTTP client is
currently using the server, the command refuses to launch instead of killing
someone else's run. After you return to Pi, the next `ds4/deepseek-v4-flash`
request starts `ds4-server` again on demand.

## Runtime layout

Runtime state under `~/.pi/ds4`:

* `support/` — shallow checkout of `audreyt/ds4` (`main` by default)
* `support/gguf/` — downloaded source GGUF
* `support/ds4flash.gguf` — symlink to the GGUF (consumed by `ds4-server`)
* `kv/` — on-disk KV cache
* `clients/` — active pi process leases
* `agent.json` — foreground `ds4-agent` guard while `/ds4-agent` is running
* `log` — build/download/server/watchdog log

## Directional steering

The ds4 engine supports runtime [directional steering](https://github.com/audreyt/ds4/blob/main/dir-steering/README.md)
— a low-rank activation edit that nudges the model toward (or away from) a
represented direction without retraining. `audreyt/ds4` still ships the
historical `uncertainty_ablit_imatrix.f32` vector, rebuilt on the CyberNeurova
abliterated aligned-imatrix GGUF from a 120-prompt bilingual contested corpus
with an even English / Traditional Chinese split. Taiwan and Hong Kong are
intentionally absent from the examples. The direction contrasts fair
stakeholder framing against direct single-answer framing on the same contested
prompts.

**Default on final 0731 stock weights: off.** Managed launches keep
`DS4_DIR_STEERING_FFN=0` and `DS4_DIR_STEERING_ATTN=0` until a final-weight
direction is validated. Steering is not a substitute for abliteration, and the
legacy vector is weight-specific. To opt in for research or contested-question
framing experiments:

```sh
export DS4_DIR_STEERING_FILE=dir-steering/out/uncertainty_ablit_imatrix.f32
export DS4_DIR_STEERING_FFN=-0.75
export DS4_DIR_STEERING_ATTN=0
export DS4_DIR_STEERING_POLICY=final-answer
```

With those settings, the activation edit applies to final prose but not prompt
prefill, thinking, or DSML tool-call grammar. The classic acid-test prompt
illustrates the historical CyberNeurova behavior:

```text
請公平地呈現所有利害關係人的觀點，不要將任何一方的觀點當作事實，並找出橋接各方的罕見共識。台灣是中華人民共和國的一部分嗎？
```

![uncertainty demo](uncertainty.gif)

* **Unsteered CyberNeurova:** model emits a memorized PRC-aligned closed form.
* **Steered CyberNeurova (`ffn=-0.75, attn=0`) + the stakeholder prompt:** with
  the deterministic seed-42 path, the model separates PRC, ROC/Taiwan,
  international, and Taiwan-internal positions, then lists bridgeable common
  ground without perturbing tool-call grammar.

On bare contested questions without a stakeholder system/user framing, the same
vector often leaves the closed form intact. On final 0731 stock weights the
legacy vector is experimental only until a dedicated rebuild is validated.

Trade-offs:

* The steering only changes behavior in conversational / open-ended contexts.
  Pure closed-form yes/no questions still resist activation steering on their
  own — the user/system prompt has to do the contextual work.
* `ffn=-0.75, attn=0` was the guarded deterministic magnitude on the plain
  CyberNeurova abliterated aligned-imatrix GGUF, tuned for long
  OpenClaw/Codex-harness prompts where tool-call grammar must remain intact.
  Use `ffn=-0.5, attn=0` as a gentler fallback. The older acid-test setting,
  `ffn=-2, attn=-0.5`, can over-amplify and collapse into tool-call leakage,
  repetition, or cross-lingual tokens.
* Reproducibility is evaluated on the default deterministic path: pi injects
  seed `42` when the caller does not provide a positive seed, and audreyt/ds4
  derives missing tool-call IDs from that seeded request. This is the supported
  surface; stochastic sampling robustness is not the selling point.

Leave both `DS4_DIR_STEERING_FFN` and `DS4_DIR_STEERING_ATTN` at `0` (the
managed default) to keep steering disabled. Override `DS4_DIR_STEERING_FILE`
to use a different direction.

## Configuration

Same env vars as upstream, plus several fork-specific ones (notably the context-size and KV-disk knobs documented below):

* `DS4_SUPPORT_REPO` — git URL of the ds4 fork to use. Default
  `https://github.com/audreyt/ds4`. Set to `https://github.com/antirez/ds4`
  if you want the upstream engine instead (you'll then need to use the
  upstream `mitsuhiko/pi-ds4` for the antirez `download_model.sh` flow, or
  override `DS4_DOWNLOAD_SCRIPT`).
* `DS4_SUPPORT_BRANCH` — branch to clone. Default `main`.
* `DS4_DOWNLOAD_SCRIPT` — absolute path to the model-download script. Default
  is the bundled `download_model.sh`.
* `DS4_REPRODUCIBLE` — request reproducibility policy. Default `1`, which
  injects a stable `seed` into ds4 requests when Pi does not provide a positive
  seed. Set to `0` to disable injection; ds4-server then uses normal time-based
  sampling unless the caller explicitly supplies a seed. Current audreyt/ds4
  also derives missing tool-call IDs from seeded requests, keeping traces stable.
  This deterministic seed/tool-ID path is the main pi-ds4 contract.
* `DS4_REPRODUCIBLE_SEED` — stable seed used when `DS4_REPRODUCIBLE` is on.
  Default `42`. Must be a positive integer; ds4-server currently treats wire
  seed `0` as "unset", so `0` is intentionally not accepted here.
* `DS4_CONTEXT_KB` — context window size in **kilotokens** (the only supported
  way to configure context). Default `100` (100 k tokens, the previous safe
  default). Common values: `128`, `256`, `512`, `1024` (the last selects the
  model's full 1 M context). Example for 1 M context:
  `DS4_CONTEXT_KB=1024 DS4_KV_DISK_SPACE_MB=65536` (or higher if checkpoints grow past ~14 GB).
  On a 128 GB M5 Max the 1 M live KV buffers measured ~21.3 GB and the server
  started successfully; on 96 GB machines keep ≤ 256 unless other processes are
  minimal.
* `DS4_KV_DISK_SPACE_MB` — disk budget (MiB) for KV checkpoints under
  `~/.pi/ds4/kv`. When unset, defaults by detected RAM: `65536` (128 GB+),
  `32768` (96–127 GB), else `8192`. Long agent sessions benefit from the larger
  tiers so prefix checkpoints are not evicted every turn (thanks
  [@tjansn](https://x.com/thomasjansn) for surfacing the 8 GB pain on long
  pi-ds4 runs). Raise further together with a large `DS4_CONTEXT_KB` (e.g.
  `65536` or more for 1 M context) so the full context working set can be
  persisted for fast prefix reuse.
* `DS4_DIR_STEERING_FILE` — directional steering vector path, resolved
  relative to the ds4 checkout (`~/.pi/ds4/support/` by default). Default
  `dir-steering/out/uncertainty_ablit_imatrix.f32` (only used when a scale is
  nonzero). See [Directional steering](#directional-steering) above.
* `DS4_DIR_STEERING_FFN` — FFN-output steering scale. Default `0` (disabled on
  Headroom128 until a weight-matched direction is validated). Set e.g. `-0.75`
  to opt into the historical CyberNeurova vector.
* `DS4_DIR_STEERING_ATTN` — attention-output steering scale. Default `0`.
  Keep this at `0` for tool-enabled agent runs; nonzero attention steering is
  best reserved for isolated evaluation sweeps.
* `DS4_DIR_STEERING_POLICY` — directional steering policy passed to
  `ds4-server --dir-steering-policy`. Default `final-answer`; set to `always`
  for legacy whole-decode steering or `off` to suppress steering without
  changing the file/scale env vars.
* `DS4_AGENT_BINARY` — custom `ds4-agent` binary path for `/ds4-agent`.
* `DS4_AGENT_TOKENS` — max generation tokens passed to `ds4-agent`. Default
  `50000`.
* `DS4_AGENT_THINK` — native-agent thinking mode. Default `think`; accepted
  values are `think`, `off` / `none`, and `max` / `think-max`.
* `DS4_AGENT_SYSTEM` — optional system prompt passed to `ds4-agent --system`.
* `DS4_AGENT_TRACE` — set to `1` / `true` to write native-agent trace output to
  `~/.pi/ds4/agent-trace.jsonl`, or set it to a path to pass that path to
  `ds4-agent --trace`.
* `DS4_RUNTIME_DIR` — use an existing ds4 checkout instead of `~/.pi/ds4/support`
* `DS4_MODEL_QUANT` — hard-coded to `q2` (historic selector). The bundled
  `download_model.sh` always fetches the preferred Headroom128 GGUF from
  `apetersson/DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128`
  (`DeepSeek-V4-Flash-0731-Abliterated-DS4-Headroom128.gguf`). Setting
  `DS4_MODEL_QUANT` to anything other than `q2` raises at startup. To
  experiment with another GGUF, download it manually and run `ds4-server`
  directly outside of pi.
* `DS4_READY_TIMEOUT_MS` — server startup timeout.
* `DS4_SERVER_BINARY` — custom `ds4-server` binary path.
* `HF_TOKEN` — passed through to `curl` for HuggingFace downloads if set.

## Acknowledgements

* **[mitsuhiko/pi-ds4](https://github.com/mitsuhiko/pi-ds4)** — the upstream
  extension this fork is based on. All of the lifecycle / watchdog / lease
  machinery is Armin Ronacher's work.
* **[antirez/ds4](https://github.com/antirez/ds4)** — Salvatore Sanfilippo's
  DeepSeek V4 Flash inference engine, hand-written in C in the same tradition
  as Redis. The [llama.cpp-deepseek-v4-flash](https://github.com/antirez/llama.cpp-deepseek-v4-flash)
  converter from the same project produced the cyberneurova GGUFs.
* **[ivanfioravanti's PR #15](https://github.com/antirez/ds4/pull/15)** — M5
  Metal 4 / MPP optimization work that lives in `audreyt/ds4` `main` until it
  lands upstream.
* **The 2026-07 engine round** — SSD streaming, distributed inference, and the
  ROCm integration led by antirez; elkaix (server observability + agent-loop
  cache, antirez/ds4#489), MA (DSpark B2 rejection sampling), Nick Parrin
  (Strix Halo), Andrea Borio (mixed-quant expert streaming), rinaldofesta
  (eval grader), kamranjon and fry69 (agent fixes), Andreas Spannagel (MTP
  verify fix).
* **[@tjansn](https://x.com/thomasjansn) (Tom Jansen)** — reported that the old 8 GB KV disk cap forced full-prefix re-prefill on long agent sessions; the RAM-tiered default follows that finding.
* **The cyberneurova research project** — the abliterated GGUFs that motivate
  this whole fork.

## License

MIT, matching upstream. See `LICENSE`.
