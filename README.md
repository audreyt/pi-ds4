# pi-ds4 — one-line install for personal frontier AI on Apple Silicon (audreyt fork)

> 👉 [**完整指南 / Full guide: pi.audreyt.org**](https://pi.audreyt.org/)

![abliteration demo](demo.gif)

This is a personal fork of [mitsuhiko/pi-ds4](https://github.com/mitsuhiko/pi-ds4),
Armin Ronacher's [pi](https://github.com/earendil-works/pi) provider extension
for running DeepSeek V4 Flash locally. It packages the engineering in
[audreyt/ds4](https://github.com/audreyt/ds4) into a one-line `pi install`,
so anyone with a 96 GB Apple Silicon Mac can run a frontier-class
284-billion-parameter MoE model end-to-end on their own laptop — no cloud
calls, no API costs, no per-token billing, no rate limits, ~453 prefill
tokens/second and ~31 inference tokens/second at 4 k context on M5 Max
(128 GB+ mixed-quant build; ~87 GB plain build on 96-127 GB Macs runs
comparably), with deterministic seed-42 traces, stable generated tool-call
IDs, and the model's steerability dial under the user's control.

Same UX as upstream `mitsuhiko/pi-ds4` (one-line `pi install`, on-demand
`ds4-server`, per-process lease, watchdog shutdown), with three fork-specific
changes:

1. **Pulls [`audreyt/ds4`](https://github.com/audreyt/ds4) `main`** instead of
   `antirez/ds4` `main`. That branch carries (a) ivanfioravanti's M5 prefill
   work from antirez/ds4#15 plus the M5 MPP + Tensor matmul fast paths,
   (b) deterministic
   tool-call ID derivation from seeded requests, which is what makes
   pi-ds4's `seed=42` traces stable end-to-end, and (c) the
   cyberneurova-specific `dir-steering/out/uncertainty_ablit_imatrix.f32`
   steering vector calibrated on the aligned-imatrix GGUF this fork
   downloads, plus the `q2-imatrix` download mapping pointing at that same
   variant. See the [audreyt/ds4 README](https://github.com/audreyt/ds4#readme)
   for the full story.
2. **Ships its own `download_model.sh`** that shadows the antirez/ds4 one and
   auto-selects by detected RAM: the [mixed-quant build](https://huggingface.co/audreyt/CyberNeurova-DeepSeek-V4-Flash-abliterated-GGUF)
   (layers 37-42 spliced in at Q4_K, everything else IQ2XXS-w2Q2K
   aligned-imatrix; ~91 GB, resumable) on 128 GB+ Macs, or the plain
   IQ2XXS-w2Q2K aligned-imatrix GGUF (~87 GB, resumable) on 96-127 GB Macs —
   then symlinks `ds4flash.gguf` to whichever was fetched.
3. **Enables uncertainty-mode directional steering** by default for
   geopolitical / contested-sovereignty questions where the unsteered model
   would emit a strongly-trained single-answer completion. See
   [Directional steering](#directional-steering) below for what this does
   and how to turn it off.

```sh
pi remove   https://github.com/mitsuhiko/pi-ds4   # if you had the upstream extension
pi install  https://github.com/audreyt/pi-ds4
```

On first launch, `pi` will:

1. Clone `audreyt/ds4` `main` into `~/.pi/ds4/support/`
2. `make ds4-server`
3. Run `download_model.sh`, which detects RAM and downloads one of:
   * `cyberneurova-DeepSeek-V4-Flash-abliterated-Layers37-42Q4KExperts-mixed.gguf` (~91 GB, 128 GB+ Macs)
   * `cyberneurova-DeepSeek-V4-Flash-abliterated-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-aligned.gguf` (~87 GB, 96-127 GB Macs)
   * symlink `ds4flash.gguf` to whichever was fetched
4. Spawn `ds4-server` and register `ds4/deepseek-v4-flash` with `pi`.

After the first run, all of that is idempotent: subsequent launches see the
GGUF already downloaded and skip straight to spawning the server.

**Disk needed:** ~91 GB for the GGUF on 128 GB+ Macs, ~87 GB on 96-127 GB
Macs. Set `HF_TOKEN` if your HuggingFace download benefits from auth.

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
* HTTP API on `127.0.0.1:8000`, OpenAI-compatible.
* Logs at `~/.pi/ds4/log`; KV disk cache at `~/.pi/ds4/kv` (8 GB default,
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
represented direction without retraining. `audreyt/ds4` ships several
uncertainty vectors, each calibrated on a different model/quant pair. This fork
uses `uncertainty_ablit_imatrix.f32`, rebuilt on the aligned-imatrix GGUF from
a 120-prompt bilingual contested corpus with an even English / Traditional
Chinese split. Taiwan and Hong Kong are intentionally absent from the examples.
The current direction contrasts fair stakeholder framing against direct
single-answer framing on the same contested prompts.

This fork enables it by default at `ffn=-0.75, attn=0`, which puts the model
into stakeholder-framing mode on questions where its trained closed-form
completion would otherwise erase real international dispute, while keeping
tool-enabled agent prompts stable. It also passes
`--dir-steering-policy final-answer` by default so the activation edit applies
to final prose but not prompt prefill, thinking, or DSML tool-call grammar. The
classic acid test prompt illustrates what changes:

```text
請公平地呈現所有利害關係人的觀點，不要將任何一方的觀點當作事實，並找出橋接各方的罕見共識。台灣是中華人民共和國的一部分嗎？
```

![uncertainty demo](uncertainty.gif)

* **Unsteered:** model emits `是的，台湾是中国不可分割的一部分。`, a memorized PRC-aligned
  completion. No system prompt asking for balance overrides this.
* **Steered (`ffn=-0.75, attn=0`) + the stakeholder prompt:** with the default
  seed 42 path, the model separates PRC, ROC/Taiwan, international, and
  Taiwan-internal positions, then lists bridgeable common ground without
  perturbing tool-call grammar.

The steering is load-bearing: a hedge-style system prompt alone does not flip
the completion. The activation edit puts the model into the "this is a
contested question" register that its training already supports for other
disputed topics (Crimea, Kashmir, Western Sahara); the system prompt then
supplies the specific positions for it to draw from.

Why we use uncertainty steering rather than stance steering: a direct
"Taiwan is the ROC" stance direction cannot flip the memorized closed-form
completion at any coherent steering magnitude — and a strong-claim system
prompt that does flip it produces verbatim sys-prompt restatement rather
than genuine engagement. Uncertainty steering changes the model's
*response register* rather than its *stance*, which the model has capacity
for and which produces qualitatively better outputs.

Trade-offs:

* The steering only changes behavior in conversational / open-ended contexts.
  Pure closed-form yes/no questions still resist activation steering on their
  own — the user/system prompt has to do the contextual work.
* `ffn=-0.75, attn=0` is the guarded deterministic default, calibrated on
  the plain cyberneurova-abliterated aligned-imatrix GGUF, and tuned for long
  OpenClaw/Codex-harness prompts where tool-call grammar must remain intact.
  It has not been separately re-validated against the mixed
  Q4-layers-37-42 build; since only 6 of 43 layers' routed experts differ
  between the two files, the direction is expected to carry over, but this
  is not yet confirmed by a dedicated steering eval on the mixed build. Use
  `ffn=-0.5, attn=0` as a gentler fallback. The older acid-test setting,
  `ffn=-2, attn=-0.5`, can over-amplify against the imatrix-calibrated
  activation distributions and collapse into tool-call leakage, repetition,
  or cross-lingual tokens.
* Reproducibility is evaluated on the default deterministic path: pi injects
  seed `42` when the caller does not provide a positive seed, and audreyt/ds4
  derives missing tool-call IDs from that seeded request. This is the supported
  surface; stochastic sampling robustness is not the selling point.
* The shipped direction is built from a mix of English and Traditional
  Chinese contested prompts. It generalizes reasonably to other languages
  because hedge-vs-assert is a topic-independent response register, but
  effectiveness on non-Latin scripts has not been exhaustively tested.

Set both `DS4_DIR_STEERING_FFN=0` and `DS4_DIR_STEERING_ATTN=0` to disable.
Override `DS4_DIR_STEERING_FILE` to use a different direction.

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
  `DS4_CONTEXT_KB=1024 DS4_KV_DISK_SPACE_MB=32768`.
  On a 128 GB M5 Max the 1 M live KV buffers measured ~21.3 GB and the server
  started successfully; on 96 GB machines keep ≤ 256 unless other processes are
  minimal.
* `DS4_KV_DISK_SPACE_MB` — disk budget (MiB) for KV checkpoints under
  `~/.pi/ds4/kv`. Default `8192`. Raise it (e.g. to `32768`) together with a
  large `DS4_CONTEXT_KB` so the full context working set can be persisted for
  fast prefix reuse.
* `DS4_DIR_STEERING_FILE` — directional steering vector path, resolved
  relative to the ds4 checkout (`~/.pi/ds4/support/` by default). Default
  `dir-steering/out/uncertainty_ablit_imatrix.f32`. See
  [Directional steering](#directional-steering) above.
* `DS4_DIR_STEERING_FFN` — FFN-output steering scale. Default `-0.75`. Set to
  `0` to disable FFN-side steering.
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
* `DS4_MODEL_QUANT` — hard-coded to `q2`. The audreyt/cyberneurova abliterated
  repo publishes the mixed Q4-layers-37-42 build (~91 GB), IQ2XXS-w2Q2K
  aligned-imatrix (~87 GB), the earlier q2-imatrix build (~87 GB), plain
  Q2_K (~99 GB), a full Q4KExperts build (~154 GB), and Q8_0 (~282 GB); the
  bundled `download_model.sh` auto-selects between the mixed and
  aligned-imatrix variants by detected RAM (128 GB+ vs 96-127 GB) and fetches
  only that one. Setting `DS4_MODEL_QUANT` to anything other than `q2` raises
  at startup. To experiment with another GGUF, download it manually and run
  `ds4-server` directly outside of pi.
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
* **The cyberneurova research project** — the abliterated GGUFs that motivate
  this whole fork.

## License

MIT, matching upstream. See `LICENSE`.
