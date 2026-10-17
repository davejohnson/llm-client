const { retryableStatus } = require("./requestTelemetry");

const PROVIDERS = new Set(["anthropic", "meta", "openai", "typesafe"]);
const CATEGORIES = new Set([
  "context_limit_exceeded",
  "credit_exhausted",
  "output_limit_reached",
  "quota_exhausted",
  "rate_limited",
  "spend_limit_exceeded",
  "usage_limit_exceeded"
]);
const SCOPES = new Set(["organization", "project"]);
const OPENAI_ERROR_CODE_DETAILS = Object.freeze({
  billing_hard_limit_reached: { category: "spend_limit_exceeded", retryable: false },
  context_length_exceeded: { category: "context_limit_exceeded", retryable: false },
  credit_balance_exhausted: { category: "credit_exhausted", scope: "organization", retryable: false },
  insufficient_quota: { category: "quota_exhausted", retryable: false },
  max_output_tokens: { category: "output_limit_reached", retryable: false },
  organization_spend_limit_exceeded: { category: "spend_limit_exceeded", scope: "organization", retryable: false },
  organization_usage_limit_exceeded: { category: "usage_limit_exceeded", scope: "organization", retryable: false },
  project_spend_limit_exceeded: { category: "spend_limit_exceeded", scope: "project", retryable: false },
  rate_limit_exceeded: { category: "rate_limited", retryable: true },
  slow_down: { category: "rate_limited", retryable: true }
});

function safeMachineIdentifier(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[a-zA-Z0-9_.:-]{1,128}$/.test(normalized) ? normalized : null;
}

function normalizedEnum(value, allowed) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return allowed.has(normalized) ? normalized : null;
}

function openAIErrorDetails(code, type) {
  const normalizedCode = typeof code === "string" ? code.toLowerCase() : null;
  const normalizedType = typeof type === "string" ? type.toLowerCase() : null;
  const exact = normalizedCode ? OPENAI_ERROR_CODE_DETAILS[normalizedCode] : null;
  if (exact) return exact;
  if (normalizedType === "insufficient_quota") {
    return { category: "quota_exhausted", retryable: false };
  }
  if (normalizedType === "rate_limit_error") {
    return { category: "rate_limited", retryable: true };
  }
  return { category: null, retryable: null };
}

function normalizeProviderFailure({
  provider,
  category = null,
  requestId = null,
  code = null,
  type = null,
  statusCode = null,
  scope = null,
  retryable = null
} = {}) {
  const safeProvider = normalizedEnum(provider, PROVIDERS);
  if (!safeProvider) {
    throw new TypeError("provider must be anthropic, meta, openai, or typesafe.");
  }
  const safeCode = safeMachineIdentifier(code);
  const safeType = safeMachineIdentifier(type);
  const safeStatusCode = Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
    ? statusCode
    : null;
  const classification = safeProvider === "openai"
    ? openAIErrorDetails(safeCode, safeType)
    : { category: null, retryable: null };
  const safeCategory = classification.category || normalizedEnum(category, CATEGORIES);
  const safeScope = classification.scope || normalizedEnum(scope, SCOPES);
  const safeRetryable = typeof classification.retryable === "boolean"
    ? classification.retryable
    : typeof retryable === "boolean"
      ? retryable
      : safeStatusCode === null
        ? null
        : retryableStatus(safeStatusCode);
  return Object.freeze({
    provider: safeProvider,
    category: safeCategory,
    requestId: safeMachineIdentifier(requestId),
    ...(safeCode ? { code: safeCode } : {}),
    ...(safeType ? { type: safeType } : {}),
    ...(safeStatusCode ? { statusCode: safeStatusCode } : {}),
    ...(safeScope ? { scope: safeScope } : {}),
    ...(typeof safeRetryable === "boolean" ? { retryable: safeRetryable } : {})
  });
}

function attachProviderError(error, details) {
  if (!error || typeof error !== "object") return error;
  error.providerError = normalizeProviderFailure(details);
  return error;
}

function providerErrorInfo(error) {
  return error?.providerError || null;
}

function isProviderCreditError(error) {
  return providerErrorInfo(error)?.category === "credit_exhausted";
}

module.exports = {
  attachProviderError,
  isProviderCreditError,
  normalizeProviderFailure,
  providerErrorInfo
};
