function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name) || headers.get(name.toLowerCase()) || null;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : null;
  return Array.isArray(value) ? value[0] || null : value || null;
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function shouldRetryError(error) {
  const explicit = headerValue(error?.headers, "x-should-retry")?.toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return error?.status === undefined || error?.status === null || retryableStatus(error.status);
}

function retryDelay(headers, attempt, { nowMs = Date.now(), random = Math.random() } = {}) {
  const retryAfterMsHeader = headerValue(headers, "retry-after-ms");
  const retryAfterMs = Number(retryAfterMsHeader);
  if (retryAfterMsHeader !== null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return retryAfterMs;

  const retryAfter = headerValue(headers, "retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  }

  return Math.min(8000, 500 * (2 ** attempt)) * (0.75 + random * 0.5);
}

function providerRequestId(value) {
  return value?._request_id
    || value?.request_id
    || value?.requestId
    || headerValue(value?.headers, "request-id")
    || headerValue(value?.headers, "x-request-id")
    || null;
}

function attemptRecord({
  attempt,
  startedAtMs,
  endedAtMs,
  outcome,
  statusCode = null,
  requestId = null,
  errorType = null,
  retryDelayMs = null
}) {
  return {
    attempt,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    elapsedMs: Math.max(0, endedAtMs - startedAtMs),
    outcome,
    statusCode: Number.isFinite(statusCode) ? statusCode : null,
    providerRequestId: requestId || null,
    errorType: errorType || null,
    retryDelayMs: Number.isFinite(retryDelayMs) ? retryDelayMs : null
  };
}

function requestTelemetry(startedAtMs, endedAtMs, attempts) {
  const finalAttempt = attempts.at(-1);
  return {
    elapsedMs: Math.max(0, endedAtMs - startedAtMs),
    providerRequestId: finalAttempt?.providerRequestId || null,
    retryCount: Math.max(0, attempts.length - 1),
    attempts
  };
}

function attachRequestTelemetry(error, telemetry) {
  if (error && typeof error === "object") error.requestTelemetry = telemetry;
  return error;
}

module.exports = {
  attachRequestTelemetry,
  attemptRecord,
  headerValue,
  providerRequestId,
  requestTelemetry,
  retryDelay,
  retryableStatus,
  shouldRetryError
};
