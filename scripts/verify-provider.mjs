import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const startBudget = (ctx, maxTokens) =>
  14_012 + 11_298 + Math.min(maxTokens, Math.floor(ctx * 0.5)) + 16_384 + 8_192 + 12_288;

async function registeredExtension() {
  const { default: register } = await import("../index.ts");
  const providers = new Map();
  const handlers = new Map();
  register({
    registerProvider(id, config) {
      providers.set(id, config);
    },
    registerCommand() {},
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  });
  return { providers, handlers };
}

async function advertisedDeepseek() {
  const { providers } = await registeredExtension();
  const model = providers.get("ds4")?.models?.find(({ id }) => id === "deepseek-v4-flash");
  return { registeredId: providers.has("ds4") ? "ds4" : undefined, model };
}

if (process.argv.includes("--override-100k")) {
  const { model } = await advertisedDeepseek();
  process.stdout.write(JSON.stringify({
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
  process.exit(0);
}

// Keep the release check independent of the invoking shell's configuration.
delete process.env.DS4_CONTEXT_KB;

const { registeredId, model } = await advertisedDeepseek();
assert.equal(registeredId, "ds4");
assert.ok(model, "ds4/deepseek-v4-flash was not registered");
assert.deepEqual(model.thinkingLevelMap, {
  off: "none",
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
});
assert.equal(model.contextWindow, 128_000, "the managed Maya vision context must fit a 128 GB Mac");
assert.equal(model.maxTokens, 64_000, "advertised maxTokens must stay under senpi's half-window reserve");
assert.ok(
  startBudget(model.contextWindow, model.maxTokens) <= model.contextWindow,
  "default window must host omo's 2026-09-27 start budget",
);
assert.deepEqual(model.input, ["text", "image"], "the managed V4.1 path runs the vision sidecar and must advertise image input");

const child = spawnSync(
  process.execPath,
  [fileURLToPath(import.meta.url), "--override-100k"],
  {
    env: { ...process.env, DS4_CONTEXT_KB: "100" },
    encoding: "utf8",
  },
);
assert.equal(child.status, 0, `100k override child failed: ${child.stderr || child.stdout}`);
const overridden = JSON.parse(child.stdout.trim());
assert.equal(overridden.contextWindow, 100_000, "DS4_CONTEXT_KB=100 must advertise a 100k window");
assert.ok(
  overridden.maxTokens < 50_000,
  `100k override must not reserve half-window output (got maxTokens=${overridden.maxTokens})`,
);
assert.ok(
  startBudget(overridden.contextWindow, overridden.maxTokens) <= overridden.contextWindow,
  `100k override must still admit (maxTokens=${overridden.maxTokens})`,
);

// The Flint tier registers next to ds4 on macOS and mirrors rec's own pi transport.
const { providers, handlers } = await registeredExtension();
const recSupported = (() => {
  if (process.platform !== "darwin" || process.arch !== "arm64") return false;
  const chip = spawnSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).stdout.trim();
  const memoryGb = Math.round(Number(spawnSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" }).stdout) / 2 ** 30);
  return /^Apple M(?:4 Pro|5 Pro|5 Max)$/.test(chip) && memoryGb >= 48;
})();
if (!recSupported && !process.env.PI_KAMI_REC_UNPINNED) {
  assert.equal(providers.has("rec"), false, "rec/flint must not be offered where rec 0.1.0 does not run");
} else if (process.platform === "darwin") {
  const rec = providers.get("rec");
  assert.ok(rec, "rec provider was not registered on macOS");
  assert.equal(rec.api, "openai-completions");
  assert.equal(rec.baseUrl, "http://127.0.0.1:11500/v1");
  assert.match(rec.apiKey, /^!.+\/\.local\/bin\/rec'? auth token$/, "pi must fetch the key from rec on each request");
  const flint = rec.models.find(({ id }) => id === "flint");
  assert.ok(flint, "rec/flint was not registered");
  assert.deepEqual(flint.input, ["text"]);
  assert.equal(flint.contextWindow, 262_144);
  const ctx = { model: { provider: "rec", id: "flint" } };
  const payload = {
    model: "flint",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    temperature: 0.7,
    top_p: 1,
    top_k: 40,
    max_completion_tokens: 100,
  };
  const rewritten = [];
  for (const handler of handlers.get("before_provider_request") ?? []) {
    const result = await handler({ payload }, ctx);
    if (result !== undefined) rewritten.push(result);
  }
  assert.equal(rewritten.length, 1, "exactly one handler must rewrite rec/flint requests");
  const [sent] = rewritten;
  for (const field of ["temperature", "top_p", "top_k", "max_completion_tokens"]) {
    assert.equal(field in sent, false, `${field} must be left to rec's defaults`);
  }
  assert.equal(sent.max_tokens, 262_144);
  assert.equal(sent.seed, 42, "reproducible mode must send seed 42 to rec");
  assert.deepEqual(sent.messages, payload.messages);
}

const recResult = providers.has("rec") ? "rec/flint seeded with rec's sampling" : "rec/flint not offered on this machine";
console.log(`Provider verified: off=none, high=high, max=max; default context=128000; maxTokens=64000; input=text+image; ${recResult}`);
