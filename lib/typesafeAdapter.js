const { attachProviderError } = require("./providerErrors");
const { attachRequestTelemetry, attemptRecord, providerRequestId, requestTelemetry, retryDelay, retryableStatus } = require("./requestTelemetry");
const { normalizeOpenAIUsage } = require("./tokenUsage");
const { validateDecisionRequest, validateDecisionResponse } = require("./decisionValidation");

function createTypeSafeAdapter({
  apiKey = process.env.TYPESAFE_API_KEY,
  baseUrl = "https://api.typesafe.ai/v1",
  fetchImpl = fetch,
  maxRetries = 2,
  timeoutMs = 60_000,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowImpl = Date.now,
  randomImpl = Math.random
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("A TypeSafe apiKey or TYPESAFE_API_KEY is required.");
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error("maxRetries must be a non-negative integer.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be positive.");

  async function decide({ model = "jev-1.13.0", state, questions }) {
    validateDecisionRequest({ model, state, questions });
    // Snapshot once so retries evaluate identical state and questions.
    const requestBody = JSON.stringify({ model, state, questions });
    const sentQuestions = JSON.parse(requestBody).questions;
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
        response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/systemone`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: requestBody,
          signal: controller.signal
        });
        const text = await response.text();
        try { body = JSON.parse(text); } catch { body = null; }
        if (!response.ok) {
          failure = new Error(body?.error?.message || (typeof body?.detail === "string" ? body.detail : `TypeSafe request failed (${response.status}).`));
          failure.status = response.status;
          failure.body = body;
          failure.headers = response.headers;
          outcome = retryableStatus(response.status) ? "retryable_error" : "error";
        } else {
          validateDecisionResponse(body, sentQuestions);
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
        throw attachProviderError(attachRequestTelemetry(failure, telemetry), { provider: "typesafe", requestId });
      }
      await sleepImpl(delay);
    }
  }
  return { provider: "typesafe", decide };
}

module.exports = { createTypeSafeAdapter };
