const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeOpenAIUsage, normalizeAnthropicUsage } = require("../lib/tokenUsage");

test("missing provider usage remains distinguishable from zero usage", () => {
  assert.equal(normalizeOpenAIUsage(null), null);
  assert.equal(normalizeAnthropicUsage(undefined), null);
});
