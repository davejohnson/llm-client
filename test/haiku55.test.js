const test = require("node:test");
const assert = require("node:assert/strict");
const Anthropic = require("@anthropic-ai/sdk");
const { createAnthropicAdapter, callStructured, resolveModelProfile, snapshotModelPricing } = require("..");

// Independent contract: Anthropic's Haiku 5.5 overview and migration guide,
// https://platform.claude.com/docs/en/models/haiku-5-5/overview
// https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide
// reviewed 2026-10-07. Fixtures are synthetic, not live model observations.
const model = "claude-haiku-5-5";
const tool = { name: "extract", input_schema: { type: "object", properties: { total: { type: "number" } }, required: ["total"], additionalProperties: false } };

test("Haiku 5.5 profile uses adaptive thinking, medium effort, and the documented output limit", () => {
  const profile = resolveModelProfile({ provider: "anthropic", model });
  assert.equal(profile.effort, "medium");
  assert.deepEqual(profile.thinking, { type: "adaptive" });
  assert.equal(profile.modelMaxOutputTokens, 128000);
  // Package defaults carried forward; not model quality measurements.
  assert.equal(profile.maxOutputTokens, 16000);
  assert.equal(profile.pagesPerChunk, undefined);
  assert.equal(profile.overlapPages, undefined);
});

test("Haiku 5.5 extraction uses forced strict tools through the real SDK HTTP boundary on retries", async () => {
  const requests = [];
  const client = new Anthropic({ apiKey: "test", maxRetries: 0, fetch: async (url, init) => {
    assert.equal(String(url), "https://api.anthropic.com/v1/messages");
    const request = JSON.parse(init.body);
    requests.push(request);
    // Haiku 5.5 explicitly accepts forced tools (without a thinking block).
    assert.deepEqual(request.tool_choice, { type: "tool", name: "extract", disable_parallel_tool_use: true });
    assert.equal(request.tools[0].strict, true);
    if (requests.length === 1) return new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', { status: 529, headers: { "retry-after": "0" } });
    return new Response(JSON.stringify({
      id: "msg_fixture", type: "message", role: "assistant", model,
      content: [{ type: "tool_use", id: "tool_fixture", name: "extract", input: { total: 42 } }],
      stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 }
    }), { headers: { "content-type": "application/json" } });
  } });
  const adapter = createAnthropicAdapter({ client, maxRetries: 1, sleepImpl: async () => {} });
  const result = await adapter.call({ model, maxOutputTokens: 12000, system: "Use extract.", userBlocks: [{ type: "text", text: "Total: 42" }], tool, effort: "medium", thinking: { type: "adaptive" } });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(result.output, { total: 42 });
  assert.equal(result.requestTelemetry.retryCount, 1);
  const integrated = await callStructured({ adapter, provider: "anthropic", model, system: "Use extract.", userBlocks: [{ type: "text", text: "Total: 42" }], tool });
  assert.equal(integrated.toolError, null);
  assert.equal(requests[2].output_config.effort, "medium");
});

// Pricing tiers apply to the entire request, including both cache write TTLs.
for (const inputTokens of [100000, 100001]) {
  for (const cacheWriteTtl of ["5m", "1h"]) {
    test(`Haiku 5.5 pricing at ${inputTokens} input tokens with ${cacheWriteTtl} writes`, () => {
      const pricing = snapshotModelPricing({ provider: "anthropic", model, cacheWriteTtl, at: "2026-10-07", tokenUsage: {
        inputTokens, uncachedInputTokens: inputTokens - 30000, cachedInputTokens: 10000,
        cacheWriteInputTokens: 20000, cacheWrite5mInputTokens: 10000, cacheWrite1hInputTokens: 10000, outputTokens: 1000
      } });
      const large = inputTokens > 100000;
      assert.deepEqual(pricing.rates, large
        ? { uncachedInput: 0.5, cachedInput: 0.05, cacheWriteInput: cacheWriteTtl === "5m" ? 0.625 : 1, cacheWrite5m: 0.625, cacheWrite1h: 1, output: 2.5 }
        : { uncachedInput: 0.1, cachedInput: 0.01, cacheWriteInput: cacheWriteTtl === "5m" ? 0.125 : 0.2, cacheWrite5m: 0.125, cacheWrite1h: 0.2, output: 0.5 });
      assert.equal(pricing.estimatedCostUsd, large ? 0.0542505 : 0.01085);
    });
  }
}

for (const streaming of [false, true]) {
test(`Haiku 5.5 ${streaming ? "streaming" : "buffered"} replays opaque thinking through the next SDK request`, async () => {
  const { callChatTurn, streamChatTurn } = require("..");
  const thinking = { type: "thinking", thinking: "", signature: "opaque-fixture-signature" };
  const content = [thinking, { type: "tool_use", id: "tool_fixture", name: "extract", input: { total: 42 } }];
  const requests = [];
  const client = new Anthropic({ apiKey: "test", maxRetries: 0, fetch: async (url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    assert.equal(request.model, model);
    assert.deepEqual(request.thinking, { type: "adaptive" });
    assert.equal(request.tool_choice.type, "auto");
    if (requests.length === 2) {
      assert.deepEqual(request.messages[1], { role: "assistant", content });
      assert.equal(request.messages[2].content[0].tool_use_id, "tool_fixture");
    }
    if (request.stream) {
      const events = [
        { type: "message_start", message: { id: "msg_stream", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: thinking.signature } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_fixture", name: "extract", input: {} } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"total":42}' } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } },
        { type: "message_stop" }
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({
      id: `msg_${requests.length}`, type: "message", role: "assistant", model,
      content: requests.length === 1 ? content : [{ type: "text", text: "Recorded." }],
      stop_reason: requests.length === 1 ? "tool_use" : "end_turn",
      stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 }
    }), { headers: { "content-type": "application/json" } });
  } });
  const params = {
    adapter: createAnthropicAdapter({ client }), provider: "anthropic", model,
    maxOutputTokens: 12000,
    system: "Use extract to record the total.",
    tools: [{ name: tool.name, inputSchema: tool.input_schema }],
    messages: [{ role: "user", content: "Total: 42" }]
  };
  let first;
  if (streaming) {
    for await (const event of streamChatTurn(params)) {
      if (event.type === "done") first = event.result;
    }
  } else first = await callChatTurn(params);
  const next = await callChatTurn({ ...params, messages: [
    ...params.messages, first.message,
    { role: "user", content: [{ type: "tool_result", toolCallId: "tool_fixture", output: "Recorded" }] }
  ] });
  assert.equal(requests.length, 2);
  assert.equal(next.message.content[0].text, "Recorded.");
});
}
