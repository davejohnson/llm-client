const test = require("node:test");
const assert = require("node:assert/strict");
const { createOpenAIAdapter, callStructured, callChatTurn, streamChatTurn, resolveModelProfile, snapshotModelPricing } = require("..");

// Official model pages and prompt-caching guide, reviewed 2026-09-22.
// Synthetic HTTP fixtures validate transport contracts, not live model quality.
const tool = { name: "extract", input_schema: { type: "object", properties: { total: { type: "number" } }, required: ["total"], additionalProperties: false } };
const response = { id: "resp_fixture", status: "completed", output: [{ type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "extract", arguments: '{"total":42}' }], usage: { input_tokens: 100, output_tokens: 10 } };

for (const [model, rates] of [["gpt-6-sol", [2, 0.2, 2.5, 10]], ["gpt-6-luna", [0.1, 0.01, 0.125, 0.5]]]) {
  test(`${model} profile and pricing match the documented limits and rates`, () => {
    const profile = resolveModelProfile({ provider: "openai", model });
    assert.equal(profile.modelMaxOutputTokens, 128000);
    assert.equal(profile.reasoningEffort, "none");
    assert.equal(profile.maxOutputTokens, 12000);
    for (const inputTokens of [272000, 272001]) {
      const price = snapshotModelPricing({ provider: "openai", model, tokenUsage: { inputTokens }, at: "2026-09-22" });
      const multiplier = inputTokens > 272000 ? 2 : 1;
      assert.deepEqual(price.rates, { uncachedInput: rates[0] * multiplier, cachedInput: rates[1] * multiplier, cacheWriteInput: rates[2] * multiplier, output: rates[3] * (inputTokens > 272000 ? 1.5 : 1) });
    }
  });

  test(`${model} uses Responses and the new cache TTL in extraction, chat, and streaming`, async () => {
    const requests = [];
    const adapter = createOpenAIAdapter({ apiKey: "test", fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      requests.push(JSON.parse(init.body));
      if (requests.at(-1).stream) {
        return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
    } });
    const base = { adapter, provider: "openai", model, system: "Use extract.", promptCacheKey: "invoice" };
    const result = await callStructured({ ...base, userBlocks: [{ type: "text", text: "Total 42" }], tool });
    assert.deepEqual(result.output, { total: 42 });
    const chat = { ...base, maxOutputTokens: 100, messages: [{ role: "user", content: "Total 42" }], tools: [{ name: tool.name, inputSchema: tool.input_schema }], toolChoice: "required" };
    await callChatTurn(chat);
    const events = [];
    for await (const event of streamChatTurn(chat)) events.push(event);
    assert.ok(events.some((event) => event.type === "done"));
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.model, model);
      assert.deepEqual(request.reasoning, { effort: "none" });
      assert.deepEqual(request.prompt_cache_options, { ttl: "30m" });
      assert.equal(request.prompt_cache_retention, undefined);
      assert.equal(request.prompt_cache_key, "invoice");
      assert.equal(request.tools[0].strict, true);
    }
  });

  test(`${model} rejects legacy cache retention locally in every request path`, async () => {
    let calls = 0;
    const adapter = createOpenAIAdapter({ apiKey: "test", promptCacheRetention: "24h", fetchImpl: async () => { calls++; return new Response(JSON.stringify(response)); } });
    const base = { model, maxOutputTokens: 100, system: "Help", messages: [{ role: "user", content: "Hello" }] };
    await assert.rejects(adapter.call({ ...base, userBlocks: [{ type: "text", text: "Hello" }], tool }), /promptCacheRetention.*30m/);
    await assert.rejects(adapter.turn(base), /promptCacheRetention.*30m/);
    await assert.rejects(async () => { for await (const event of adapter.streamTurn(base)) void event; }, /promptCacheRetention.*30m/);
    assert.equal(calls, 0);
  });
}
