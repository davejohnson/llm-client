const { buildTelemetry } = require("./structuredCall");
const { snapshotModelPricing } = require("./priceCatalog");
const { validateDecisionRequest, validateDecisionResponse } = require("./decisionValidation");

// Separate profiles: decision models have no generated-output or PDF budgets.
const BUILTIN_DECISION_PROFILES = Object.freeze(Object.fromEntries(
  ["jev-1.13.0", "jev-latest", "jev-preview"].map((model) => {
    const id = `typesafe/${model}`;
    return [id, Object.freeze({ id, provider: "typesafe", model })];
  })
));

async function callDecision({ adapter, provider = "typesafe", model = "jev-1.13.0", state, questions }) {
  if (!adapter || typeof adapter.decide !== "function") throw new Error("A decision adapter with decide() is required.");
  if (adapter.provider !== provider) throw new Error(`Adapter provider ${adapter.provider} does not match ${provider}.`);
  const profile = BUILTIN_DECISION_PROFILES[`${provider}/${model}`];
  if (!profile) throw new Error(`Unknown decision model ${provider}/${model}; a reviewed decision profile is required.`);
  validateDecisionRequest({ model, state, questions });
  const request = JSON.parse(JSON.stringify({ model, state, questions }));
  const startedAtMs = Date.now();
  try {
    const result = await adapter.decide(request);
    validateDecisionResponse(result, request.questions);
    const telemetry = buildTelemetry({ provider, model, profile, tokenUsage: result.tokenUsage,
      requestMetadata: result.requestTelemetry, startedAtMs, endedAtMs: Date.now(), outcome: "success" });
    // Price the resolved version, never assume an alias still points to the reviewed release.
    telemetry.pricing = snapshotModelPricing({ provider, model: result.model, tokenUsage: result.tokenUsage });
    telemetry.resolvedModel = result.model;
    return { ...result, profile, telemetry };
  } catch (error) {
    error.telemetry = buildTelemetry({ provider, model, profile, tokenUsage: null,
      requestMetadata: error.requestTelemetry, startedAtMs, endedAtMs: Date.now(), outcome: "error", error });
    throw error;
  }
}

module.exports = { BUILTIN_DECISION_PROFILES, callDecision };
