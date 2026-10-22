import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const startBudget = (ctx, maxTokens) =>
  14_012 + 11_298 + Math.min(maxTokens, Math.floor(ctx * 0.5)) + 16_384 + 8_192 + 12_288;

async function advertisedDeepseek() {
  const { default: register } = await import("../index.ts");
  let registeredId;
  let registeredConfig;
  register({
    registerProvider(id, config) {
      registeredId = id;
      registeredConfig = config;
    },
    registerCommand() {},
    on() {},
  });
  const model = registeredConfig?.models?.find(({ id }) => id === "deepseek-v4-flash");
  return { registeredId, model };
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

console.log("Provider verified: off=none, high=high, max=max; default context=128000; maxTokens=64000; input=text+image");
