const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { callDecision, createTypeSafeAdapter, normalizeProviderFailure, providerErrorInfo } = require("..");

test("shared failure normalization accepts the TypeSafe provider", () => {
  const failure = normalizeProviderFailure({ provider: "typesafe", statusCode: 429 });
  assert.equal(failure.provider, "typesafe");
  assert.equal(failure.retryable, true);
});

// Wire shapes and fractional score are based on https://docs.typesafe.ai/api
// (reviewed 2026-09-20), not captured live responses or request-derived echoes.
const questions = {
  route: { type: "choice", instructions: "Route this record", criteria: { accept: null, review: "Needs review" } },
  quality: { type: "score", instructions: { question: "Rate completeness" }, criteria: ["Missing", "Partial", "Complete"] },
  valid: { type: "noul", instructions: "Is the record valid?" }
};
function responseBody() {
  return {
    model: "jev-1.13.0",
    answers: {
      route: { type: "choice", choice: "accept", probabilities: { accept: 0.88, review: 0.12 }, confidence: 0.81 },
      quality: { type: "score", score: 1.05, probabilities: { "0": 0, "1": 0.95, "2": 0.05 }, legend: { "0": "Missing", "1": "Partial", "2": "Complete" }, confidence: 0.92 },
      valid: { type: "noul", noul: 0.95 }
    },
    usage: { input_tokens: 304, output_tokens: 18 }
  };
}
async function serverFor(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/v1`;
}
function jsonResponse(body = responseBody(), status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("Jev uses the decision HTTP boundary and preserves all three typed answers", async (t) => {
  const requests = [];
  const baseUrl = await serverFor(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, method: req.method, auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { "content-type": "application/json", "x-request-id": "decision-1" });
    res.end(JSON.stringify(responseBody()));
  });
  const result = await callDecision({ adapter: createTypeSafeAdapter({ apiKey: "test", baseUrl }), state: { text: "Invoice record" }, questions });
  assert.deepEqual(requests, [{ path: "/v1/systemone", method: "POST", auth: "Bearer test", body: { model: "jev-1.13.0", state: { text: "Invoice record" }, questions } }]);
  assert.deepEqual(result.answers, responseBody().answers);
  assert.equal(result.model, "jev-1.13.0");
  assert.equal(result.tokenUsage.totalTokens, 322);
  assert.equal(result.telemetry.provider, "typesafe");
  assert.equal(result.telemetry.providerRequestId, "decision-1");
  assert.equal(result.telemetry.pricing.estimatedCostUsd, 0.000012768);
});

test("Jev retries overload and rate limits with the same decision body", async () => {
  const bodies = [], delays = [];
  const adapter = createTypeSafeAdapter({ apiKey: "test", sleepImpl: async (ms) => delays.push(ms), fetchImpl: async (url, init) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    bodies.push(init.body);
    return bodies.length < 3
      ? new Response('{"detail":"busy"}', { status: bodies.length === 1 ? 429 : 529, headers: { "retry-after": "0.01" } })
      : jsonResponse();
  } });
  const result = await callDecision({ adapter, state: "record", questions });
  assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(delays, [10, 10]);
  assert.equal(result.telemetry.retryCount, 2);
  assert.deepEqual(result.telemetry.attempts.map((a) => a.statusCode), [429, 529, 200]);
});

test("Jev authentication errors retain provider metadata and are not retried", async () => {
  let calls = 0;
  const adapter = createTypeSafeAdapter({ apiKey: "test", fetchImpl: async () => {
    calls++;
    return new Response('{"detail":"Invalid key"}', { status: 401, headers: { "x-request-id": "denied" } });
  } });
  await assert.rejects(callDecision({ adapter, state: "record", questions }), (error) => {
    assert.equal(error.status, 401);
    assert.equal(providerErrorInfo(error).provider, "typesafe");
    assert.equal(error.telemetry.providerRequestId, "denied");
    return true;
  });
  assert.equal(calls, 1);
});

test("Jev rejects malformed decisions before application code can branch on them", async () => {
  const mutations = [
    (b) => { delete b.answers.valid; },
    (b) => { b.answers.valid.noul = 2; },
    (b) => { b.answers.route.choice = "unknown"; },
    (b) => { b.answers.quality.score = "1.05"; },
    (b) => { b.answers.route.probabilities.review = -1; },
    (b) => { b.answers.route.type = "score"; },
    (b) => { b.usage.input_tokens = -1; }
  ];
  for (const mutate of mutations) {
    let calls = 0;
    const body = responseBody(); mutate(body);
    const adapter = createTypeSafeAdapter({ apiKey: "test", fetchImpl: async () => { calls++; return jsonResponse(body); } });
    await assert.rejects(callDecision({ adapter, state: "record", questions }), /Invalid TypeSafe response/);
    assert.equal(calls, 1);
  }
});

test("Jev validates requests before sending and accepts structured instructions", async () => {
  let calls = 0;
  const adapter = createTypeSafeAdapter({ apiKey: "test", fetchImpl: async () => { calls++; return jsonResponse(); } });
  for (const override of [
    { state: null }, { questions: {} }, { model: "unreviewed-model" },
    { questions: { q: { type: "score", instructions: "Rate", criteria: ["One"] } } },
    { questions: { q: { type: "text", instructions: "Write" } } },
    { questions: { q: { type: "choice", instructions: "Choose", criteria: {} } } }
  ]) await assert.rejects(callDecision({ adapter, state: "record", questions, ...override }));
  assert.equal(calls, 0);
  await callDecision({ adapter, state: ["record"], questions });
  assert.equal(calls, 1);
});

test("Jev times out during response consumption and records the failed attempt", async (t) => {
  const baseUrl = await serverFor(t, (req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{'); });
  const adapter = createTypeSafeAdapter({ apiKey: "test", baseUrl, timeoutMs: 40, maxRetries: 0 });
  await assert.rejects(callDecision({ adapter, state: "record", questions }), (error) => {
    assert.equal(error.telemetry.attempts[0].outcome, "timeout");
    return true;
  });
});

test("Jev alias pricing follows the returned model and preserves an unknown version", async () => {
  const body = responseBody(); body.model = "jev-future";
  const adapter = createTypeSafeAdapter({ apiKey: "test", fetchImpl: async () => jsonResponse(body) });
  const result = await callDecision({ adapter, model: "jev-latest", state: "record", questions });
  assert.equal(result.telemetry.model, "jev-latest");
  assert.equal(result.telemetry.resolvedModel, "jev-future");
  assert.equal(result.telemetry.pricing.estimatedCostUsd, null);
});

test("Jev retries network errors and reports retry exhaustion", async () => {
  let calls = 0;
  const adapter = createTypeSafeAdapter({ apiKey: "test", maxRetries: 1, sleepImpl: async () => {}, fetchImpl: async () => {
    calls++; throw new TypeError("Connection lost");
  } });
  await assert.rejects(callDecision({ adapter, state: "record", questions }), (error) => {
    assert.equal(error.telemetry.retryCount, 1);
    assert.equal(error.telemetry.attempts[1].outcome, "network_error");
    return true;
  });
  assert.equal(calls, 2);
});

test("Jev rejects non-JSON success without retrying", async () => {
  let calls = 0;
  const adapter = createTypeSafeAdapter({ apiKey: "test", fetchImpl: async () => { calls++; return new Response("not JSON"); } });
  await assert.rejects(callDecision({ adapter, state: "record", questions }), (error) => {
    assert.equal(error.telemetry.attempts[0].outcome, "invalid_response");
    return true;
  });
  assert.equal(calls, 1);
});
