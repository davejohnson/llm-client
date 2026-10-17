const { resolveModelProfile } = require("./modelProfiles");
const { normalizeSystem } = require("./systemPrompt");
const { toolInputValidationError } = require("./outputValidation");
const { snapshotModelPricing } = require("./priceCatalog");

function syntheticAttempt({ startedAtMs, endedAtMs, outcome, error = null }) {
  return {
    attempt: 1,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    elapsedMs: Math.max(0, endedAtMs - startedAtMs),
    outcome,
    statusCode: Number.isFinite(error?.status) ? error.status : null,
    providerRequestId: error?.requestId || error?.request_id || null,
    errorType: error?.type || error?.name || null,
    retryDelayMs: null
  };
}

function buildTelemetry({
  provider,
  model,
  profile,
  tokenUsage,
  requestMetadata,
  pricingContext,
  startedAtMs,
  endedAtMs,
  outcome,
  error = null
}) {
  const attempts = Array.isArray(requestMetadata?.attempts) && requestMetadata.attempts.length
    ? requestMetadata.attempts
    : [syntheticAttempt({ startedAtMs, endedAtMs, outcome, error })];
  return {
    schemaVersion: 1,
    provider,
    model,
    profileId: profile.id,
    tokenUsage: tokenUsage || null,
    elapsedMs: Math.max(0, endedAtMs - startedAtMs),
    providerRequestId: requestMetadata?.providerRequestId || attempts.at(-1)?.providerRequestId || null,
    retryCount: Number.isInteger(requestMetadata?.retryCount)
      ? requestMetadata.retryCount
      : Math.max(0, attempts.length - 1),
    attempts,
    pricing: snapshotModelPricing({
      provider,
      model,
      tokenUsage,
      cacheWriteTtl: pricingContext?.cacheWriteTtl,
      at: new Date(endedAtMs)
    })
  };
}

async function callStructured({
  adapter,
  provider,
  model,
  profileId,
  profiles,
  system,
  userBlocks,
  tool,
  maxOutputTokens,
  promptCacheKey
}) {
  if (!adapter || typeof adapter.call !== "function") throw new Error("A provider adapter with call() is required.");
  if (!tool?.name || !tool?.input_schema) throw new Error("A structured output tool is required.");
  if (adapter.provider !== provider) throw new Error(`Adapter provider ${adapter.provider || "unknown"} does not match ${provider}.`);
  if (promptCacheKey !== undefined && (typeof promptCacheKey !== "string" || !promptCacheKey.trim())) {
    throw new Error("promptCacheKey must be a non-empty string.");
  }
  const profile = resolveModelProfile({ provider, model, profileId, profiles });
  const outputBudget = maxOutputTokens === undefined
    ? profile.maxOutputTokens
    : maxOutputTokens;
  if (!Number.isInteger(outputBudget) || outputBudget < 1) {
    throw new Error("maxOutputTokens must be a positive integer.");
  }
  const modelMaxOutputTokens = profile.modelMaxOutputTokens || profile.maxOutputTokens;
  if (outputBudget > modelMaxOutputTokens) {
    throw new Error(`maxOutputTokens cannot exceed the reviewed model limit of ${modelMaxOutputTokens}.`);
  }
  const startedAtMs = Date.now();
  try {
    const result = await adapter.call({
      model,
      maxOutputTokens: outputBudget,
      system: normalizeSystem(system),
      userBlocks,
      tool,
      effort: profile.effort,
      thinking: profile.thinking,
      pdfDetail: profile.pdfDetail,
      reasoningEffort: profile.reasoningEffort,
      promptCacheKey
    });
    const validationError = !result.toolError && result.output !== null && result.output !== undefined
      ? toolInputValidationError(tool.name, result.output, tool.input_schema)
      : null;
    const validatedResult = validationError
      ? { ...result, toolError: validationError }
      : result;
    const endedAtMs = Date.now();
    const telemetry = buildTelemetry({
      provider,
      model,
      profile,
      tokenUsage: result.tokenUsage,
      requestMetadata: result.requestTelemetry,
      pricingContext: adapter.pricingContext,
      startedAtMs,
      endedAtMs,
      outcome: "success"
    });
    return { ...validatedResult, profile, telemetry };
  } catch (error) {
    const endedAtMs = Date.now();
    error.telemetry = buildTelemetry({
      provider,
      model,
      profile,
      tokenUsage: null,
      requestMetadata: error.requestTelemetry,
      pricingContext: adapter.pricingContext,
      startedAtMs,
      endedAtMs,
      outcome: "error",
      error
    });
    throw error;
  }
}

module.exports = { buildTelemetry, callStructured };
