const test = require("node:test");
const assert = require("node:assert/strict");
const Anthropic = require("@anthropic-ai/sdk");
const { createAnthropicAdapter, callStructured, resolveModelProfile, snapshotModelPricing } = require("..");

// Independent contract: Anthropic's Opus 5.5 overview and migration guide,
// reviewed 2026-09-22. Fixtures are synthetic, not live model observations.
const model = "claude-opus-5-5";
const tool = { name: "extract", input_schema: { type: "object", properties: { total: { type: "number" } }, required: ["total"], additionalProperties: false } };

test("Opus 5.5 profile uses adaptive thinking, medium effort, and the documented output limit", () => {
  const profile = resolveModelProfile({ provider: "anthropic", model });
  assert.equal(profile.effort, "medium");
  assert.deepEqual(profile.thinking, { type: "adaptive" });
  assert.equal(profile.modelMaxOutputTokens, 128000);
  // Package defaults carried forward; not model quality measurements.
  assert.equal(profile.maxOutputTokens, 16000);
  assert.equal(profile.pagesPerChunk, 30);
  assert.equal(profile.overlapPages, 3);
});

test("Opus 5.5 extraction uses automatic strict tools through the real SDK HTTP boundary on retries", async () => {
  const requests = [];
  const client = new Anthropic({ apiKey: "test", maxRetries: 0, fetch: async (url, init) => {
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    const request = JSON.parse(init.body);
    requests.push(request);
    // Independent documented restriction: named/any tool choices are invalid.
    if (["tool", "any"].includes(request.tool_choice.type)) return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: 'tool_choice: type "tool" and "any" are not supported for this model.' } }), { status: 400 });
    assert.deepEqual(request.tool_choice, { type: "auto", disable_parallel_tool_use: true });
    assert.equal(request.tools[0].strict, true);
    if (requests.length === 1) return new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', { status: 529, headers: { "retry-after": "0" } });
    return new Response(JSON.stringify({
      id: "msg_fixture", type: "message", role: "assistant", model,
      content: [{ type: "thinking", thinking: "", signature: "fixture-signature" }, { type: "tool_use", id: "tool_fixture", name: "extract", input: { total: 42 } }],
      stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 }
    }), { headers: { "content-type": "application/json" } });
  } });
  const adapter = createAnthropicAdapter({ client, maxRetries: 1, sleepImpl: async () => {} });
  const result = await adapter.call({ model, maxOutputTokens: 16000, system: "Use extract.", userBlocks: [{ type: "text", text: "Total: 42" }], tool, effort: "medium", thinking: { type: "adaptive" } });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(result.output, { total: 42 });
  assert.equal(result.requestTelemetry.retryCount, 1);
  const integrated = await callStructured({ adapter, provider: "anthropic", model, system: "Use extract.", userBlocks: [{ type: "text", text: "Total: 42" }], tool });
  assert.equal(integrated.toolError, null);
  assert.equal(requests[2].output_config.effort, "medium");
});

test("Opus 5.5 rejects forced tools in both chat paths before network access", async () => {
  let calls = 0;
  const adapter = createAnthropicAdapter({ client: { messages: {
    create: async () => { calls++; return { content: [] }; },
    stream: () => { calls++; throw new Error("Unexpected network access"); }
  } } });
  const base = { model, maxOutputTokens: 100, system: "Help", messages: [{ role: "user", content: "Look up the total" }], tools: [{ name: "extract", inputSchema: tool.input_schema }] };
  for (const toolChoice of ["required", { type: "tool", name: "extract" }]) {
    await assert.rejects(adapter.turn({ ...base, toolChoice }), /does not support required or named toolChoice/);
    await assert.rejects(async () => { for await (const event of adapter.streamTurn({ ...base, toolChoice })) void event; }, /does not support required or named toolChoice/);
  }
  assert.equal(calls, 0);
});

test("Opus 5.5 pricing includes the published cache read and both cache write rates", () => {
  const pricing = snapshotModelPricing({ provider: "anthropic", model, at: "2026-09-22", tokenUsage: {
    inputTokens: 4000000, uncachedInputTokens: 1000000, cachedInputTokens: 1000000,
    cacheWriteInputTokens: 2000000, cacheWrite5mInputTokens: 1000000, cacheWrite1hInputTokens: 1000000, outputTokens: 1000000
  } });
  assert.deepEqual(pricing.rates, { uncachedInput: 4, cachedInput: 0.2, cacheWriteInput: 5, cacheWrite5m: 5, cacheWrite1h: 8, output: 20 });
  assert.equal(pricing.estimatedCostUsd, 37.2);
});
