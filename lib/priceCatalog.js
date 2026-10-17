const PRICE_CATALOG_VERSION = "2026-10-07";
const PER_MILLION_TOKENS = "per_million_tokens";

function anthropicRates(uncachedInput, cachedInput, cacheWrite5m, cacheWrite1h, output) {
  return { uncachedInput, cachedInput, cacheWrite5m, cacheWrite1h, output };
}

function openAIRates(uncachedInput, cachedInput, cacheWriteInput, output) {
  return { uncachedInput, cachedInput, cacheWriteInput, output };
}

const OPENAI_LONG_CONTEXT = Object.freeze({
  inputTokenThreshold: 272000,
  inputRateMultiplier: 2,
  outputRateMultiplier: 1.5
});

const PRICE_CATALOG = deepFreeze({
  version: PRICE_CATALOG_VERSION,
  currency: "USD",
  unit: PER_MILLION_TOKENS,
  models: {
    "anthropic/claude-haiku-5-5": {
      schedules: [{ id: "standard", rates: anthropicRates(0.1, 0.01, 0.125, 0.2, 0.5) }],
      longContext: { inputTokenThreshold: 100000, inputRateMultiplier: 5, outputRateMultiplier: 5 },
      source: "https://platform.claude.com/docs/en/models/haiku-5-5/overview"
    },
    "openai/gpt-6-sol": {
      schedules: [{ id: "standard", rates: openAIRates(2, 0.2, 2.5, 10) }],
      longContext: OPENAI_LONG_CONTEXT,
      source: "https://developers.openai.com/api/docs/models/gpt-6-sol"
    },
    "openai/gpt-6-luna": {
      schedules: [{ id: "standard", rates: openAIRates(0.1, 0.01, 0.125, 0.5) }],
      longContext: OPENAI_LONG_CONTEXT,
      source: "https://developers.openai.com/api/docs/models/gpt-6-luna"
    },
    "typesafe/jev-1.13.0": {
      schedules: [{ id: "standard", rates: { uncachedInput: 0.042, cachedInput: 0.042, cacheWriteInput: 0.042, output: 0 } }],
      source: "https://docs.typesafe.ai/models"
    },
    "anthropic/claude-haiku-4-5": {
      schedules: [{
        id: "standard",
        rates: anthropicRates(1, 0.1, 1.25, 2, 5)
      }],
      source: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching"
    },
    "anthropic/claude-opus-4-8": {
      schedules: [{
        id: "standard",
        rates: anthropicRates(5, 0.5, 6.25, 10, 25)
      }],
      source: "https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8"
    },
    "anthropic/claude-opus-5": {
      schedules: [{
        id: "standard",
        rates: anthropicRates(5, 0.5, 6.25, 10, 25)
      }],
      source: "https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5"
    },
    "anthropic/claude-opus-5-5": {
      schedules: [{ id: "standard", rates: anthropicRates(4, 0.2, 5, 8, 20) }],
      source: "https://platform.claude.com/docs/en/models/opus-5-5/overview"
    },
    "anthropic/claude-fable-5-1": {
      schedules: [{
        id: "standard",
        rates: anthropicRates(10, 0.25, 12.5, 20, 50)
      }],
      source: "https://platform.claude.com/docs/en/models/fable-5-1/overview"
    },
    "anthropic/claude-mythos-5-1": {
      schedules: [{
        id: "standard",
        rates: anthropicRates(10, 0.25, 12.5, 20, 50)
      }],
      source: "https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1"
    },
    "anthropic/claude-sonnet-5-5": {
      schedules: [{ id: "standard", rates: anthropicRates(2, 0.2, 2.5, 4, 10) }],
      source: "https://platform.claude.com/docs/en/models/sonnet-5-5/overview"
    },
    "anthropic/claude-sonnet-5": {
      schedules: [
        {
          id: "introductory",
          effectiveUntil: "2026-08-09T23:59:59.999Z",
          rates: anthropicRates(2, 0.2, 2.5, 4, 10)
        },
        {
          id: "standard",
          effectiveFrom: "2026-08-10T00:00:00.000Z",
          rates: anthropicRates(2, 0.2, 2.5, 4, 10)
        }
      ],
      source: "https://platform.claude.com/docs/en/about-claude/pricing"
    },
    "meta/muse-spark-1.3": {
      schedules: [{ id: "standard", rates: openAIRates(1.25, 0.15, 1.25, 4.25) }],
      source: "https://dev.meta.ai/docs/getting-started/pricing-rate-limits"
    },
    "openai/gpt-5.4": {
      schedules: [{ id: "standard", rates: openAIRates(2.5, 0.25, 2.5, 15) }],
      longContext: OPENAI_LONG_CONTEXT,
      source: "https://developers.openai.com/api/docs/models/gpt-5.4"
    },
    "openai/gpt-5.4-mini": {
      schedules: [{ id: "standard", rates: openAIRates(0.75, 0.075, 0.75, 4.5) }],
      source: "https://developers.openai.com/api/docs/models/gpt-5.4-mini"
    },
    "openai/gpt-5.4-nano": {
      schedules: [{ id: "standard", rates: openAIRates(0.2, 0.02, 0.2, 1.25) }],
      source: "https://developers.openai.com/api/docs/models/gpt-5.4-nano"
    },
    "openai/gpt-5.5": {
      schedules: [{ id: "standard", rates: openAIRates(5, 0.5, 5, 30) }],
      longContext: OPENAI_LONG_CONTEXT,
      source: "https://developers.openai.com/api/docs/models/gpt-5.5"
    },
    "openai/gpt-5.6": {
      schedules: [{ id: "standard", rates: openAIRates(5, 0.5, 6.25, 30) }],
      longContext: OPENAI_LONG_CONTEXT,
      source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol"
    },
    "openai/gpt-5.6-sol": {
      schedules: [{ id: "standard", rates: openAIRates(5, 0.5, 6.25, 30) }],
      longContext: OPENAI_LONG_CONTEXT,
      source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol"
    },
    "openai/gpt-5.6-terra": {
      schedules: [{ id: "standard", rates: openAIRates(2.5, 0.25, 3.125, 15) }],
      longContext: OPENAI_LONG_CONTEXT,
      source: "https://developers.openai.com/api/docs/models/gpt-5.6-terra"
    },
    "openai/gpt-5.6-luna": {
      schedules: [{ id: "standard", rates: openAIRates(1, 0.1, 1.25, 6) }],
      longContext: OPENAI_LONG_CONTEXT,
      source: "https://developers.openai.com/api/docs/models/gpt-5.6-luna"
    }
  }
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function scheduleForDate(schedules, atMs) {
  return schedules.find((schedule) => {
    const afterStart = !schedule.effectiveFrom || atMs >= Date.parse(schedule.effectiveFrom);
    const beforeEnd = !schedule.effectiveUntil || atMs <= Date.parse(schedule.effectiveUntil);
    return afterStart && beforeEnd;
  }) || null;
}

function roundUsd(value) {
  return Math.round((value + Number.EPSILON) * 1e12) / 1e12;
}

function tokenCount(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function unavailableSnapshot(reason, effectiveAt, cacheWriteTtl) {
  return {
    catalogVersion: PRICE_CATALOG_VERSION,
    available: false,
    currency: PRICE_CATALOG.currency,
    unit: PRICE_CATALOG.unit,
    effectiveAt,
    cacheWriteTtl,
    rateScheduleId: null,
    rates: null,
    rateModifiers: [],
    estimatedCostByCategoryUsd: null,
    estimatedCostUsd: null,
    unavailableReason: reason
  };
}

function snapshotModelPricing({
  provider,
  model,
  tokenUsage,
  cacheWriteTtl = "5m",
  at = new Date()
}) {
  const atDate = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(atDate.getTime())) throw new Error("Pricing snapshot date must be valid.");
  const effectiveAt = atDate.toISOString();
  const entry = PRICE_CATALOG.models[`${provider}/${model}`];
  const pricingCacheWriteTtl = provider === "anthropic" ? cacheWriteTtl : null;
  if (!entry) return unavailableSnapshot("unknown_model", effectiveAt, pricingCacheWriteTtl);

  const schedule = scheduleForDate(entry.schedules, atDate.getTime());
  if (!schedule) return unavailableSnapshot("no_applicable_rate_schedule", effectiveAt, pricingCacheWriteTtl);
  if (provider === "anthropic" && !["5m", "1h"].includes(cacheWriteTtl)) {
    throw new Error("cacheWriteTtl must be 5m or 1h.");
  }

  const rawRates = schedule.rates;
  const rates = {
    uncachedInput: rawRates.uncachedInput,
    cachedInput: rawRates.cachedInput,
    cacheWriteInput: provider === "anthropic"
      ? rawRates[cacheWriteTtl === "1h" ? "cacheWrite1h" : "cacheWrite5m"]
      : rawRates.cacheWriteInput,
    output: rawRates.output
  };
  if (provider === "anthropic") {
    rates.cacheWrite5m = rawRates.cacheWrite5m;
    rates.cacheWrite1h = rawRates.cacheWrite1h;
  }
  const rateModifiers = [];
  if (entry.longContext && tokenUsage?.inputTokens > entry.longContext.inputTokenThreshold) {
    rates.uncachedInput *= entry.longContext.inputRateMultiplier;
    rates.cachedInput *= entry.longContext.inputRateMultiplier;
    rates.cacheWriteInput *= entry.longContext.inputRateMultiplier;
    if (provider === "anthropic") {
      rates.cacheWrite5m *= entry.longContext.inputRateMultiplier;
      rates.cacheWrite1h *= entry.longContext.inputRateMultiplier;
    }
    rates.output *= entry.longContext.outputRateMultiplier;
    rateModifiers.push({
      type: "long_context",
      inputTokenThreshold: entry.longContext.inputTokenThreshold,
      inputRateMultiplier: entry.longContext.inputRateMultiplier,
      outputRateMultiplier: entry.longContext.outputRateMultiplier
    });
  }

  const base = {
    catalogVersion: PRICE_CATALOG_VERSION,
    available: true,
    currency: PRICE_CATALOG.currency,
    unit: PRICE_CATALOG.unit,
    effectiveAt,
    cacheWriteTtl: pricingCacheWriteTtl,
    rateScheduleId: schedule.id,
    rates,
    rateModifiers
  };
  if (!tokenUsage) {
    return {
      ...base,
      estimatedCostByCategoryUsd: null,
      estimatedCostUsd: null,
      unavailableReason: "missing_token_usage"
    };
  }

  const cacheWrite5mInputTokens = tokenCount(tokenUsage.cacheWrite5mInputTokens);
  const cacheWrite1hInputTokens = tokenCount(tokenUsage.cacheWrite1hInputTokens);
  const uncategorizedCacheWriteInputTokens = Math.max(
    0,
    tokenCount(tokenUsage.cacheWriteInputTokens) - cacheWrite5mInputTokens - cacheWrite1hInputTokens
  );
  const estimatedCostByCategoryUsd = {
    uncachedInput: roundUsd(tokenCount(tokenUsage.uncachedInputTokens) * rates.uncachedInput / 1e6),
    cachedInput: roundUsd(tokenCount(tokenUsage.cachedInputTokens) * rates.cachedInput / 1e6),
    cacheWriteInput: roundUsd(uncategorizedCacheWriteInputTokens * rates.cacheWriteInput / 1e6),
    ...(provider === "anthropic" ? {
      cacheWrite5m: roundUsd(cacheWrite5mInputTokens * rates.cacheWrite5m / 1e6),
      cacheWrite1h: roundUsd(cacheWrite1hInputTokens * rates.cacheWrite1h / 1e6)
    } : {}),
    output: roundUsd(tokenCount(tokenUsage.outputTokens) * rates.output / 1e6)
  };
  return {
    ...base,
    estimatedCostByCategoryUsd,
    estimatedCostUsd: roundUsd(Object.values(estimatedCostByCategoryUsd).reduce((total, cost) => total + cost, 0)),
    unavailableReason: null
  };
}

module.exports = {
  PRICE_CATALOG,
  PRICE_CATALOG_VERSION,
  snapshotModelPricing
};
