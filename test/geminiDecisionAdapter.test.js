const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { BUILTIN_DECISION_PROFILES, callDecision, createGeminiDecisionAdapter, createTypeSafeAdapter, providerErrorInfo } = require("..");

const questions = {
  route: { type: "choice", instructions: "Classify this message.", criteria: { invoice: "A bill for goods or services", spam: "Unsolicited or deceptive", other: null } },
  urgency: { type: "score", instructions: "How urgent is it?", criteria: ["Not urgent", "Somewhat urgent", "Very urgent"] },
  isInvoice: { type: "noul", instructions: "Is this a vendor invoice?", criteria: { true: "A bill from a vendor", false: "Anything else" } },
  plain: { type: "noul", instructions: "Does it mention money?" }
};
// The response shape, key order and usage block are from a live gemini-decision-1 response
// captured 2026-11-25; the values are shortened. The response names no model.
function responseBody() {
  return {
    answers: {
      route: { confidence: 0.98, choice: "invoice", probabilities: { other: 0.009, invoice: 0.98, spam: 0.011 }, type: "choice" },
      urgency: { confidence: 0.55, score: 0.96, probabilities: { "0": 0.245, "2": 0.205, "1": 0.55 }, legend: { "0": "Not urgent", "2": "Very urgent", "1": "Somewhat urgent" }, type: "score" },
      isInvoice: { confidence: 0.97, noul: 0.97, type: "noul" },
      plain: { confidence: 0.9, noul: 0.9, type: "noul" }
    },
    usage: { total_tokens: 265, total_input_tokens: 265, input_tokens_by_modality: [{ modality: "text", tokens: 265 }], total_output_tokens: 0 }
  };
}
const jsonResponse = (body = responseBody(), status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("Gemini Decision uses its own endpoint, key header and wire names, and returns the shared answer shapes", async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, method: req.method, key: req.headers["x-goog-api-key"], auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(responseBody()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const adapter = createGeminiDecisionAdapter({ apiKey: "test", baseUrl: `http://127.0.0.1:${server.address().port}/v1beta/` });

  const result = await callDecision({ adapter, state: "Invoice 4417 from Acme", questions });
  assert.deepEqual(requests, [{
    path: "/v1beta/decisions", method: "POST", key: "test", auth: undefined,
    body: {
      model: "gemini-decision-1",
      input: "Invoice 4417 from Acme",
      questions: {
        route: questions.route,
        urgency: questions.urgency,
        isInvoice: { type: "noul", instructions: "Is this a vendor invoice?", criteria: { true_description: "A bill from a vendor", false_description: "Anything else" } },
        plain: questions.plain
      }
    }
  }]);
  assert.deepEqual(result.answers, responseBody().answers);
  // The response doesn't name the model, so the one asked for is reported.
  assert.equal(result.model, "gemini-decision-1");
  assert.equal(result.tokenUsage.inputTokens, 265);
  assert.equal(result.tokenUsage.outputTokens, 0);
  assert.equal(result.telemetry.provider, "google");
  assert.equal(result.telemetry.resolvedModel, "gemini-decision-1");
  assert.equal(result.telemetry.pricing.estimatedCostUsd, 0.0000265);
  assert.equal(result.profile, BUILTIN_DECISION_PROFILES["google/gemini-decision-1"]);
});

test("Gemini Decision rejects malformed answers and usage before application code can branch on them", async () => {
  const mutations = [
    (b) => { delete b.answers.plain; },
    (b) => { b.answers.isInvoice.noul = 1.2; },
    (b) => { b.answers.route.choice = "unknown"; },
    (b) => { b.answers.urgency.type = "choice"; },
    (b) => { delete b.usage.total_input_tokens; },
    (b) => { b.usage = null; }
  ];
  for (const mutate of mutations) {
    let calls = 0;
    const body = responseBody(); mutate(body);
    const adapter = createGeminiDecisionAdapter({ apiKey: "test", fetchImpl: async () => { calls++; return jsonResponse(body); } });
    await assert.rejects(callDecision({ adapter, state: "record", questions }), /Invalid Gemini response/);
    assert.equal(calls, 1);
  }
});

test("Gemini Decision retries rate limits with the same body and reports Google's error without retrying a bad key", async () => {
  const bodies = [];
  const retried = createGeminiDecisionAdapter({ apiKey: "test", sleepImpl: async () => {}, fetchImpl: async (url, init) => {
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/decisions");
    bodies.push(init.body);
    return bodies.length < 2 ? jsonResponse({ error: { code: 429, message: "Resource exhausted", status: "RESOURCE_EXHAUSTED" } }, 429) : jsonResponse();
  } });
  const result = await callDecision({ adapter: retried, state: "record", questions });
  assert.equal(new Set(bodies).size, 1);
  assert.equal(result.telemetry.retryCount, 1);

  let calls = 0;
  const denied = createGeminiDecisionAdapter({ apiKey: "test", fetchImpl: async () => { calls++; return jsonResponse({ error: { code: 400, message: "API key not valid.", status: "INVALID_ARGUMENT" } }, 400); } });
  await assert.rejects(callDecision({ adapter: denied, state: "record", questions }), (error) => {
    assert.equal(error.message, "API key not valid.");
    assert.equal(providerErrorInfo(error).provider, "google");
    return true;
  });
  assert.equal(calls, 1);
});

test("each decision provider keeps its own default model and reviewed profiles", async () => {
  const gemini = createGeminiDecisionAdapter({ apiKey: "test", fetchImpl: async () => jsonResponse() });
  // A Jev model is not a reviewed Gemini profile, and the adapter must match a named provider.
  await assert.rejects(callDecision({ adapter: gemini, model: "jev-1.13.0", state: "record", questions }), /Unknown decision model google\/jev-1\.13\.0/);
  await assert.rejects(callDecision({ adapter: gemini, provider: "typesafe", state: "record", questions }), /does not match typesafe/);
  const jev = createTypeSafeAdapter({ apiKey: "test", fetchImpl: async () => { throw new Error("not reached"); } });
  await assert.rejects(callDecision({ adapter: jev, model: "gemini-decision-1", state: "record", questions }), /Unknown decision model typesafe\/gemini-decision-1/);
  assert.throws(() => createGeminiDecisionAdapter({ apiKey: "" }), /Gemini apiKey or GEMINI_API_KEY/);
});

test("Gemini Decision sends structured state, instructions and descriptions as JSON text", async () => {
  let sent;
  const adapter = createGeminiDecisionAdapter({ apiKey: "test", fetchImpl: async (url, init) => {
    sent = JSON.parse(init.body);
    return jsonResponse({ answers: { ok: { type: "noul", noul: 0.5, confidence: 0.5 }, level: { type: "score", score: 1, confidence: 1, probabilities: { "0": 0, "1": 1 }, legend: { "0": "a", "1": "b" } } }, usage: { total_input_tokens: 9, total_output_tokens: 0 } });
  } });
  await callDecision({ adapter, state: { vendor: "Acme", total: 42.5 }, questions: {
    ok: { type: "noul", instructions: { question: "Complete?" }, criteria: { true: ["all fields"] } },
    level: { type: "score", instructions: "Rate", criteria: ["Low", { label: "High" }] }
  } });
  assert.equal(sent.input, '{"vendor":"Acme","total":42.5}');
  assert.deepEqual(sent.questions.ok, { type: "noul", instructions: '{"question":"Complete?"}', criteria: { true_description: '["all fields"]' } });
  assert.deepEqual(sent.questions.level.criteria, ["Low", '{"label":"High"}']);
});
