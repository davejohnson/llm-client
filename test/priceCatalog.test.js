const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BUILTIN_MODEL_PROFILES,
  PRICE_CATALOG,
  PRICE_CATALOG_VERSION,
  snapshotModelPricing
} = require("..");

function usage({
  uncachedInputTokens = 0,
  cachedInputTokens = 0,
  cacheWriteInputTokens = 0,
  cacheWrite5mInputTokens = 0,
  cacheWrite1hInputTokens = 0,
  outputTokens = 0
} = {}) {
  const inputTokens = uncachedInputTokens + cachedInputTokens + cacheWriteInputTokens;
  return {
    inputTokens,
    uncachedInputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    cacheWrite5mInputTokens,
    cacheWrite1hInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + outputTokens
  };
}

test("the versioned price catalog covers every built-in model", () => {
  assert.equal(PRICE_CATALOG.version, PRICE_CATALOG_VERSION);
  for (const profile of Object.values(BUILTIN_MODEL_PROFILES)) {
    assert.ok(PRICE_CATALOG.models[`${profile.provider}/${profile.model}`]);
  }
  assert.ok(Object.isFrozen(PRICE_CATALOG));
  assert.ok(Object.isFrozen(PRICE_CATALOG.models["openai/gpt-5.4-mini"]));
});

test("pricing snapshots estimate costs by normalized token category", () => {
  const snapshot = snapshotModelPricing({
    provider: "openai",
    model: "gpt-5.4-mini",
    tokenUsage: usage({
      uncachedInputTokens: 1000000,
      cachedInputTokens: 1000000,
      cacheWriteInputTokens: 1000000,
      outputTokens: 1000000
    }),
    at: "2026-07-17T00:00:00.000Z"
  });

  assert.deepEqual(snapshot.rates, {
    uncachedInput: 0.75,
    cachedInput: 0.075,
    cacheWriteInput: 0.75,
    output: 4.5
  });
  assert.deepEqual(snapshot.estimatedCostByCategoryUsd, {
    uncachedInput: 0.75,
    cachedInput: 0.075,
    cacheWriteInput: 0.75,
    output: 4.5
  });
  assert.equal(snapshot.estimatedCostUsd, 6.075);
});

test("Anthropic pricing preserves Sonnet 5's schedule history at its permanent launch price", () => {
  const tokenUsage = usage({
    cacheWriteInputTokens: 1000000,
    cacheWrite5mInputTokens: 600000,
    cacheWrite1hInputTokens: 400000
  });
  const introductory5m = snapshotModelPricing({
    provider: "anthropic",
    model: "claude-sonnet-5",
    tokenUsage,
    cacheWriteTtl: "5m",
    at: "2026-07-17T00:00:00.000Z"
  });
  const introductory1h = snapshotModelPricing({
    provider: "anthropic",
    model: "claude-sonnet-5",
    tokenUsage,
    cacheWriteTtl: "1h",
    at: "2026-07-17T00:00:00.000Z"
  });
  const september = snapshotModelPricing({
    provider: "anthropic",
    model: "claude-sonnet-5",
    tokenUsage,
    cacheWriteTtl: "5m",
    at: "2026-09-01T00:00:00.000Z"
  });

  assert.equal(introductory5m.rateScheduleId, "introductory");
  assert.equal(introductory5m.rates.cacheWriteInput, 2.5);
  assert.equal(introductory1h.rates.cacheWriteInput, 4);
  assert.equal(september.rateScheduleId, "standard");
  assert.equal(september.rates.cacheWriteInput, 2.5);
  assert.deepEqual(introductory5m.estimatedCostByCategoryUsd, {
    uncachedInput: 0,
    cachedInput: 0,
    cacheWriteInput: 0,
    cacheWrite5m: 1.5,
    cacheWrite1h: 1.6,
    output: 0
  });
  assert.equal(introductory5m.estimatedCostUsd, 3.1);
});

test("Claude 5.1 pricing includes quarter-price cache reads", () => {
  for (const model of ["claude-fable-5-1", "claude-mythos-5-1"]) {
    const snapshot = snapshotModelPricing({
      provider: "anthropic",
      model,
      tokenUsage: usage({
        uncachedInputTokens: 1000000,
        cachedInputTokens: 1000000,
        cacheWriteInputTokens: 2000000,
        cacheWrite5mInputTokens: 1000000,
        cacheWrite1hInputTokens: 1000000,
        outputTokens: 1000000
      }),
      at: "2026-09-02T00:00:00.000Z"
    });

    assert.equal(snapshot.available, true);
    assert.deepEqual(snapshot.rates, {
      uncachedInput: 10,
      cachedInput: 0.25,
      cacheWrite5m: 12.5,
      cacheWrite1h: 20,
      cacheWriteInput: 12.5,
      output: 50
    });
    assert.equal(snapshot.estimatedCostUsd, 92.75);
  }
});

test("Muse Spark 1.3 pricing includes automatic prompt-cache reads", () => {
  const snapshot = snapshotModelPricing({
    provider: "meta",
    model: "muse-spark-1.3",
    tokenUsage: usage({
      uncachedInputTokens: 1000000,
      cachedInputTokens: 1000000,
      outputTokens: 1000000
    }),
    at: "2026-09-02T00:00:00.000Z"
  });

  assert.equal(snapshot.available, true);
  assert.deepEqual(snapshot.rates, {
    uncachedInput: 1.25,
    cachedInput: 0.15,
    cacheWriteInput: 1.25,
    output: 4.25
  });
  assert.equal(snapshot.estimatedCostUsd, 5.65);
});

test("Haiku 4.5 pricing includes prompt cache categories", () => {
  const snapshot = snapshotModelPricing({
    provider: "anthropic",
    model: "claude-haiku-4-5",
    tokenUsage: usage({
      uncachedInputTokens: 1000000,
      cachedInputTokens: 1000000,
      cacheWriteInputTokens: 2000000,
      cacheWrite5mInputTokens: 1000000,
      cacheWrite1hInputTokens: 1000000,
      outputTokens: 1000000
    }),
    at: "2026-07-18T00:00:00.000Z"
  });

  assert.equal(snapshot.available, true);
  assert.equal(snapshot.estimatedCostUsd, 9.35);
});

test("long-context pricing snapshots apply model rate multipliers", () => {
  const snapshot = snapshotModelPricing({
    provider: "openai",
    model: "gpt-5.5",
    tokenUsage: usage({ uncachedInputTokens: 272001, outputTokens: 1000 }),
    at: "2026-07-17T00:00:00.000Z"
  });

  assert.deepEqual(snapshot.rates, {
    uncachedInput: 10,
    cachedInput: 1,
    cacheWriteInput: 10,
    output: 45
  });
  assert.equal(snapshot.rateModifiers[0].type, "long_context");
});

test("unknown models retain an explicitly unavailable estimate rather than zero", () => {
  const snapshot = snapshotModelPricing({
    provider: "openai",
    model: "gpt-future",
    tokenUsage: usage({ uncachedInputTokens: 1000, outputTokens: 100 }),
    at: "2026-07-17T00:00:00.000Z"
  });

  assert.equal(snapshot.available, false);
  assert.equal(snapshot.rates, null);
  assert.equal(snapshot.estimatedCostUsd, null);
  assert.equal(snapshot.unavailableReason, "unknown_model");
});
