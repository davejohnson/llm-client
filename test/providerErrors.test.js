const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isProviderCreditError,
  normalizeProviderFailure,
  providerErrorInfo
} = require("..");
const { attachProviderError } = require("../lib/providerErrors");

test("provider errors expose a neutral classification envelope", () => {
  const error = new Error("billing failed");

  attachProviderError(error, {
    provider: "anthropic",
    category: "credit_exhausted",
    requestId: "req_123"
  });

  assert.deepEqual(providerErrorInfo(error), {
    provider: "anthropic",
    category: "credit_exhausted",
    requestId: "req_123"
  });
  assert.equal(isProviderCreditError(error), true);
});

test("provider error helpers preserve ordinary errors", () => {
  const error = new Error("network failed");

  assert.equal(providerErrorInfo(error), null);
  assert.equal(isProviderCreditError(error), false);
  assert.equal(attachProviderError(error, { provider: "openai" }), error);
  assert.deepEqual(providerErrorInfo(error), {
    provider: "openai",
    category: null,
    requestId: null
  });
});

test("provider errors expose only explicit safe machine-readable details", () => {
  const error = new Error("provider message must stay outside the normalized envelope");

  attachProviderError(error, {
    provider: "openai",
    category: "spend_limit_exceeded",
    code: "project_spend_limit_exceeded",
    type: "insufficient_quota",
    statusCode: 429,
    scope: "project",
    retryable: false,
    requestId: "req_spend"
  });

  assert.deepEqual(providerErrorInfo(error), {
    provider: "openai",
    category: "spend_limit_exceeded",
    requestId: "req_spend",
    code: "project_spend_limit_exceeded",
    type: "insufficient_quota",
    statusCode: 429,
    scope: "project",
    retryable: false
  });
  assert.equal(Object.hasOwn(providerErrorInfo(error), "message"), false);
});

test("normalizes every exact OpenAI provider failure without an adapter call", () => {
  const cases = [
    ["billing_hard_limit_reached", "spend_limit_exceeded", null, false],
    ["context_length_exceeded", "context_limit_exceeded", null, false],
    ["credit_balance_exhausted", "credit_exhausted", "organization", false],
    ["insufficient_quota", "quota_exhausted", null, false],
    ["max_output_tokens", "output_limit_reached", null, false],
    ["organization_spend_limit_exceeded", "spend_limit_exceeded", "organization", false],
    ["organization_usage_limit_exceeded", "usage_limit_exceeded", "organization", false],
    ["project_spend_limit_exceeded", "spend_limit_exceeded", "project", false],
    ["rate_limit_exceeded", "rate_limited", null, true],
    ["slow_down", "rate_limited", null, true]
  ];

  for (const [code, category, scope, retryable] of cases) {
    assert.deepEqual(normalizeProviderFailure({
      provider: "openai",
      code,
      type: "provider_error",
      statusCode: 429,
      requestId: "req_123"
    }), {
      provider: "openai",
      category,
      requestId: "req_123",
      code,
      type: "provider_error",
      statusCode: 429,
      ...(scope ? { scope } : {}),
      retryable
    });
  }
});

test("normalizes exact OpenAI types but never assigns a category from status", () => {
  assert.deepEqual(normalizeProviderFailure({
    provider: "openai",
    type: "insufficient_quota",
    statusCode: 429
  }), {
    provider: "openai",
    category: "quota_exhausted",
    requestId: null,
    type: "insufficient_quota",
    statusCode: 429,
    retryable: false
  });
  assert.deepEqual(normalizeProviderFailure({
    provider: "openai",
    type: "rate_limit_error",
    statusCode: 429
  }), {
    provider: "openai",
    category: "rate_limited",
    requestId: null,
    type: "rate_limit_error",
    statusCode: 429,
    retryable: true
  });
  assert.deepEqual(normalizeProviderFailure({
    provider: "openai",
    statusCode: 429
  }), {
    provider: "openai",
    category: null,
    requestId: null,
    statusCode: 429,
    retryable: true
  });
});

test("normalizes the exact Responses incomplete output-limit reason without prose inference", () => {
  assert.deepEqual(normalizeProviderFailure({
    provider: "openai",
    code: "max_output_tokens"
  }), {
    provider: "openai",
    category: "output_limit_reached",
    requestId: null,
    code: "max_output_tokens",
    retryable: false
  });
  assert.deepEqual(normalizeProviderFailure({
    provider: "openai",
    code: "content_filter"
  }), {
    provider: "openai",
    category: null,
    requestId: null,
    code: "content_filter"
  });
});

test("exact OpenAI classification overrides contradictory retryability", () => {
  assert.deepEqual(normalizeProviderFailure({
    provider: "openai",
    code: "rate_limit_exceeded",
    statusCode: 429,
    retryable: false
  }), {
    provider: "openai",
    category: "rate_limited",
    requestId: null,
    code: "rate_limit_exceeded",
    statusCode: 429,
    retryable: true
  });
  assert.deepEqual(normalizeProviderFailure({
    provider: "openai",
    code: "credit_balance_exhausted",
    statusCode: 429,
    retryable: true
  }), {
    provider: "openai",
    category: "credit_exhausted",
    requestId: null,
    code: "credit_balance_exhausted",
    statusCode: 429,
    scope: "organization",
    retryable: false
  });
});

test("normalization is frozen, idempotent, and excludes prose and unknown fields", () => {
  const input = Object.freeze({
    provider: "openai",
    category: "not_a_category",
    requestId: "request id with spaces",
    code: "unsafe code",
    type: "unsafe/type",
    statusCode: 429,
    scope: "account",
    retryable: false,
    message: "secret provider prose",
    credential: "secret"
  });
  const original = { ...input };
  const normalized = normalizeProviderFailure(input);

  assert.deepEqual(normalized, {
    provider: "openai",
    category: null,
    requestId: null,
    statusCode: 429,
    retryable: false
  });
  assert.equal(Object.isFrozen(normalized), true);
  assert.deepEqual(input, original);
  assert.deepEqual(normalizeProviderFailure(normalized), normalized);
  assert.equal(Object.hasOwn(normalized, "message"), false);
  assert.equal(Object.hasOwn(normalized, "credential"), false);
});

test("normalization accepts only supported providers", () => {
  assert.throws(
    () => normalizeProviderFailure({ provider: "other-provider" }),
    /provider must be anthropic, meta, openai, or typesafe/
  );
});

test("provider errors drop unsafe request identifiers", () => {
  const error = new Error("provider failure");

  attachProviderError(error, {
    provider: "openai",
    requestId: "request id with spaces and unsafe copy"
  });

  assert.deepEqual(providerErrorInfo(error), {
    provider: "openai",
    category: null,
    requestId: null
  });
});

test("provider error attachment remains an internal API", () => {
  assert.equal(require("..").attachProviderError, undefined);
  assert.equal(typeof require("..").normalizeProviderFailure, "function");
});
