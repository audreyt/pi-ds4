import assert from "node:assert/strict";

// Keep the release check independent of the invoking shell's configuration.
delete process.env.DS4_CONTEXT_KB;

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

assert.equal(registeredId, "ds4");
const model = registeredConfig?.models?.find(({ id }) => id === "deepseek-v4-flash");
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
assert.equal(model.contextWindow, 100_000, "the conservative default context changed");
assert.deepEqual(model.input, ["text", "image"], "Vision-Exp managed path must advertise image input");

console.log("Provider verified: off=none, high=high, max=max; default context=100000; input=text+image");
