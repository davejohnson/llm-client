const { attachProviderError } = require("./providerErrors");
const { attachRequestTelemetry, attemptRecord, providerRequestId, requestTelemetry, retryDelay, retryableStatus } = require("./requestTelemetry");
const { normalizeOpenAIUsage } = require("./tokenUsage");
const { validateDecisionRequest, validateDecisionResponse } = require("./decisionValidation");

/**
 * The HTTP boundary every decision provider shares: one POST per attempt with
 * an identical body, a per-attempt timeout, backoff on retryable failures, and
 * an answer validated against the questions that were sent. A provider supplies
 * its endpoint, its headers, and how its wire shapes map to the package's.
 */
function createDecisionAdapter({
  provider, label, apiKey, url, headers, defaultModel,
  toWire = (request) => request,
  fromWire = (body) => body,
  fetchImpl = fetch,
  maxRetries = 2,
  timeoutMs = 60_000,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowImpl = Date.now,
  randomImpl = Math.random
}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error(`A ${label} apiKey is required.`);
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error("maxRetries must be a non-negative integer.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be positive.");

  async function decide({ model = defaultModel, state, questions }) {
    validateDecisionRequest({ model, state, questions });
    // Snapshot once so retries evaluate identical state and questions.
    const sent = JSON.parse(JSON.stringify({ model, state, questions }));
    const requestBody = JSON.stringify(toWire(sent));
    const startedAtMs = nowImpl();
    const attempts = [];
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const attemptStartedAtMs = nowImpl();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      let response;
      let body;
      let failure;
      let outcome;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: requestBody,
          signal: controller.signal
        });
        const text = await response.text();
        try { body = JSON.parse(text); } catch { body = null; }
        if (!response.ok) {
          failure = new Error(body?.error?.message || (typeof body?.detail === "string" ? body.detail : `${label} request failed (${response.status}).`));
          failure.status = response.status;
          failure.body = body;
          failure.headers = response.headers;
          outcome = retryableStatus(response.status) ? "retryable_error" : "error";
        } else {
          body = fromWire(body, sent);
          validateDecisionResponse(body, sent.questions, label);
          outcome = "success";
        }
      } catch (error) {
        failure = error;
        outcome = controller.signal.aborted ? "timeout" : error.name === "DecisionResponseError" ? "invalid_response" : "network_error";
      } finally {
        clearTimeout(timer);
      }
      const endedAtMs = nowImpl();
      const canRetry = failure && attempt < maxRetries && ["retryable_error", "timeout", "network_error"].includes(outcome);
      const delay = canRetry ? retryDelay(response?.headers, attempt, { nowMs: endedAtMs, random: randomImpl() }) : null;
      const requestId = providerRequestId(response);
      attempts.push(attemptRecord({ attempt: attempt + 1, startedAtMs: attemptStartedAtMs, endedAtMs, outcome,
        statusCode: response?.status, requestId, errorType: failure?.name, retryDelayMs: delay }));
      const telemetry = requestTelemetry(startedAtMs, endedAtMs, attempts);
      if (!failure) return {
        model: body.model,
        answers: body.answers,
        usage: body.usage,
        tokenUsage: normalizeOpenAIUsage({ input_tokens: body.usage.input_tokens, output_tokens: body.usage.output_tokens }),
        requestTelemetry: telemetry
      };
      if (!canRetry) {
        throw attachProviderError(attachRequestTelemetry(failure, telemetry), { provider, requestId });
      }
      await sleepImpl(delay);
    }
  }
  return { provider, decide };
}

module.exports = { createDecisionAdapter };
