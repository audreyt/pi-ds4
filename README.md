# pi-ds4 — one-line install for personal frontier AI on Apple Silicon (audreyt fork)

> 👉 [**完整指南 / Full guide: pi.audreyt.org**](https://pi.audreyt.org/)

![abliteration demo](demo.gif)

This is a personal fork of [mitsuhiko/pi-ds4](https://github.com/mitsuhiko/pi-ds4),
Armin Ronacher's [pi](https://github.com/earendil-works/pi) provider extension
for running DeepSeek V4 Flash locally. It packages the engineering in
[audreyt/ds4](https://github.com/audreyt/ds4) into a one-line `pi install`,
so anyone with a 96 GB Apple Silicon Mac can run a frontier-class
284-billion-parameter MoE model end-to-end on their own laptop — no cloud
calls, no API costs, no per-token billing, no rate limits, ~440 prefill
tokens/second, ~30 inference tokens/second, with deterministic seed-42 traces,
stable generated tool-call IDs, and the model's steerability dial under the
user's control.

Same UX as upstream `mitsuhiko/pi-ds4` (one-line `pi install`, on-demand
`ds4-server`, per-process lease, watchdog shutdown), with three fork-specific
changes:

1. **Pulls [`audreyt/ds4`](https://github.com/audreyt/ds4) `main`** instead of
   `antirez/ds4` `main`. That branch carries (a) ivanfioravanti's M5 prefill
   work from antirez/ds4#15, extended into Metal 4 M5 MPP + Tensor matmul
   fast paths (~2× prefill and ~1.5× generation vs `antirez/main` on an M5
   Max, per the audreyt/ds4 README benchmark sweep), (b) deterministic
   tool-call ID derivation from seeded requests, which is what makes
   pi-ds4's `seed=42` traces stable end-to-end, and (c) the
   cyberneurova-specific `dir-steering/out/uncertainty_ablit_imatrix.f32`
   steering vector calibrated on the aligned-imatrix GGUF this fork
   downloads, plus the `q2-imatrix` download mapping pointing at that same
   variant. See the [audreyt/ds4 README](https://github.com/audreyt/ds4#readme)
   for the full story.
2. **Ships its own `download_model.sh`** that shadows the antirez/ds4 one,
   fetching the [cyberneurova abliterated IQ2XXS-w2Q2K aligned-imatrix GGUF](https://huggingface.co/audreyt/CyberNeurova-DeepSeek-V4-Flash-abliterated-GGUF)
   (~87 GB, resumable) and symlinking `ds4flash.gguf` to it.
3. **Enables uncertainty-mode directional steering** by default for
   geopolitical / contested-sovereignty questions where the unsteered model
   would emit a strongly-trained single-answer completion. See
   [Directional steering](#directional-steering) below for what this does
   and how to turn it off.

```sh
pi remove   github.com/mitsuhiko/pi-ds4   # if you had the upstream extension
pi install  github.com/audreyt/pi-ds4
```

On first launch, `pi` will:

1. Clone `audreyt/ds4` `main` into `~/.pi/ds4/support/`
2. `make ds4-server`
3. Run `download_model.sh`:
   * download `cyberneurova-DeepSeek-V4-Flash-abliterated-IQ2XXS-w2Q2K-AProjQ8-SExpQ8-OutQ8-chat-v2-imatrix-aligned.gguf` (~87 GB)
   * symlink `ds4flash.gguf` to it
4. Spawn `ds4-server` and register `ds4/deepseek-v4-flash` with `pi`.

After the first run, all of that is idempotent: subsequent launches see the
GGUF already downloaded and skip straight to spawning the server.

**Disk needed:** ~87 GB for the GGUF. Set `HF_TOKEN` if your HuggingFace
download benefits from auth.

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
* Logs at `~/.pi/ds4/log`; KV disk cache at `~/.pi/ds4/kv` with
  `--kv-disk-space-mb 8192` by default.
* `/ds4` inside `pi` shows the live ds4 log.

The only differences are the fork-specific changes above: the ds4 source it
pulls, the model it downloads, and the steering defaults it applies.

## Runtime layout

Runtime state under `~/.pi/ds4`:

* `support/` — shallow checkout of `audreyt/ds4` (`main` by default)
* `support/gguf/` — downloaded source GGUF
* `support/ds4flash.gguf` — symlink to the GGUF (consumed by `ds4-server`)
* `kv/` — on-disk KV cache
* `clients/` — active pi process leases
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
* `ffn=-0.75, attn=0` is the guarded deterministic default on the
  cyberneurova-abliterated aligned-imatrix GGUF (the file this fork downloads).
  It is tuned for long OpenClaw/Codex-harness prompts where tool-call grammar
  must remain intact. Use `ffn=-0.5, attn=0` as a gentler fallback. The older
  acid-test setting, `ffn=-2, attn=-0.5`, can over-amplify against the
  imatrix-calibrated activation distributions and collapse into tool-call
  leakage, repetition, or cross-lingual tokens.
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

Same env vars as upstream, plus a couple of fork-specific ones:

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
* `DS4_MT` — Metal Tensor policy passed to `ds4-server --mt`. Default `auto`
  on macOS (engages validated Metal Tensor routes on M5 + Metal 4 tensor API; falls
  back automatically on older targets). Set to `off` to force the legacy
  Metal path, or `on` for the diagnostic full-Tensor profile (may drift). On
  non-Darwin platforms (e.g. running a CUDA fork of ds4 on Linux) the flag is
  omitted by default since `--mt` is Metal-only; set `DS4_MT` explicitly if
  your build accepts it. `DS4_MPP` is still accepted as a legacy env alias,
  but pi-ds4 passes `--mt` to ds4-server.
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
* `DS4_RUNTIME_DIR` — use an existing ds4 checkout instead of `~/.pi/ds4/support`
* `DS4_MODEL_QUANT` — hard-coded to `q2`. The audreyt/cyberneurova abliterated
  repo publishes IQ2XXS-w2Q2K aligned-imatrix (~87 GB), the earlier q2-imatrix
  build (~87 GB), plain Q2_K (~99 GB), and Q8_0 (~282 GB); the bundled
  `download_model.sh` only fetches the aligned-imatrix variant. Setting
  `DS4_MODEL_QUANT` to anything other than `q2` raises at startup. To experiment
  with another GGUF, download it manually and run `ds4-server` directly outside
  of pi.
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
