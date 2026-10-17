const test = require("node:test");
const assert = require("node:assert/strict");
const { retryDelay, shouldRetryError } = require("../lib/requestTelemetry");

test("retry delays honor provider headers and otherwise use bounded backoff", () => {
  assert.equal(retryDelay({ "retry-after-ms": "125" }, 0), 125);
  assert.equal(retryDelay({ "retry-after": "2" }, 0), 2000);
  assert.equal(retryDelay(null, 0, { nowMs: 0, random: 0.5 }), 500);
  assert.equal(retryDelay(null, 8, { nowMs: 0, random: 0.5 }), 8000);
});

test("Anthropic explicit retry headers override status defaults", () => {
  assert.equal(shouldRetryError({ status: 400, headers: { "x-should-retry": "true" } }), true);
  assert.equal(shouldRetryError({ status: 503, headers: { "x-should-retry": "false" } }), false);
});
