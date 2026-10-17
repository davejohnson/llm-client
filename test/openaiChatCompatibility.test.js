const test = require("node:test");
const assert = require("node:assert/strict");
const { callChatTurn, streamChatTurn, callStructured, createOpenAIAdapter, resolveModelProfile, snapshotModelPricing } = require("..");
const { normalizeChatMessages } = require("../lib/chatTurn");

// Explicit chat presets are opt-in package controls. The default document
// profiles keep their independent reasoning and chunking settings.
const models = ["gpt-5.4-mini", "gpt-6-luna", "gpt-6-sol"];
const tool = { name: "capture_value", input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } };

for (const model of models) {
  test(`${model} retains separate document and low-reasoning chat profiles`, () => {
    const chat = resolveModelProfile({ provider: "openai", model, profileId: `openai/${model}-chat` });
    assert.equal(chat.reasoningEffort, "low");
    assert.equal(chat.maxOutputTokens, 12000);
    assert.equal(chat.modelMaxOutputTokens, 128000);
    assert.equal(chat.pagesPerChunk, undefined);
    assert.equal(chat.pdfDetail, undefined);
    assert.equal(resolveModelProfile({ provider: "openai", model }).reasoningEffort, "none");
  });

  test(`${model} sends explicit chat controls and caller-selected structured output budgets`, async () => {
    const requests = [];
    const response = { id: "response_fixture", status: "completed", output: [{ type: "function_call", call_id: "call_fixture", name: "capture_value", arguments: '{"value":"sample"}' }], usage: { input_tokens: 100, output_tokens: 8 } };
    const adapter = createOpenAIAdapter({ apiKey: "test", fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      const request = JSON.parse(init.body);
      requests.push(request);
      return request.stream
        ? new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } })
        : new Response(JSON.stringify(response));
    } });
    const base = { adapter, provider: "openai", model, profileId: `openai/${model}-chat`, system: "Use the supplied tool.", promptCacheKey: "chat-profile-contract" };
    const chat = { ...base, maxOutputTokens: 2048, messages: [{ role: "user", content: "The value is sample." }], tools: [{ name: tool.name, inputSchema: tool.input_schema }], parallelToolCalls: false };
    await callChatTurn(chat);
    for await (const event of streamChatTurn(chat)) void event;
    const profile = resolveModelProfile(base);
    // Exercise both public ways to choose a smaller output budget: a reusable
    // caller-defined profile and a one-call override of the built-in profile.
    const compactProfile = { ...profile, id: `${profile.id}/compact`, maxOutputTokens: 128 };
    const userBlocks = [{ type: "text", text: "The value is sample." }];
    const result = await callStructured({ ...base, profileId: compactProfile.id, profiles: { [compactProfile.id]: compactProfile }, userBlocks, tool });
    assert.deepEqual(result.output, { value: "sample" });
    const bounded = await callStructured({ ...base, maxOutputTokens: 64, userBlocks, tool });
    assert.deepEqual(bounded.output, { value: "sample" });
    assert.equal(requests.length, 4);
    for (const request of requests) {
      assert.deepEqual(request.reasoning, { effort: "low" });
      assert.equal(request.prompt_cache_key, "chat-profile-contract");
      assert.equal(request.prompt_cache_retention, undefined);
      assert.deepEqual(request.prompt_cache_options, model.startsWith("gpt-6-") ? { ttl: "30m" } : undefined);
    }
    assert.deepEqual(requests.map((request) => request.max_output_tokens), [2048, 2048, 128, 64]);
    assert.equal(requests[0].store, false);
    assert.equal(requests[1].store, false);
    for (const request of requests.slice(2)) {
      assert.deepEqual(request.tool_choice, { type: "function", name: "capture_value" });
      assert.equal(request.tools[0].strict, true);
    }
  });
}

// Independent API evidence: https://developers.openai.com/api/docs/guides/reasoning
// (2026-09-23), "Preserve reasoning without stored responses": store:false
// returns encrypted reasoning by default; replay reasoning and assistant phase.
for (const streaming of [false, true]) {
  test(`OpenAI ${streaming ? "streaming" : "buffered"} chat replays opaque reasoning and distinct assistant phases through the real adapter`, async () => {
    const requests = [];
    const reasoning = { type: "reasoning", id: "reasoning_fixture", encrypted_content: "opaque-fixture", summary: [] };
    const response = { id: "response_fixture", status: "completed", output: [
      reasoning,
      { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Checking the value." }] },
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Here is the value." }] },
      { type: "function_call", call_id: "call_fixture", name: "capture_value", arguments: '{"value":"sample"}' }
    ], usage: { input_tokens: 10, output_tokens: 10 } };
    const adapter = createOpenAIAdapter({ apiKey: "test", fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      return request.stream
        ? new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } })
        : new Response(JSON.stringify(response));
    } });
    const firstUser = { role: "user", content: "Check the value." };
    const base = { model: "gpt-5.4-mini", maxOutputTokens: 2048, reasoningEffort: "low", tools: [{ name: tool.name, inputSchema: tool.input_schema }] };
    let first;
    if (streaming) {
      for await (const event of adapter.streamTurn({ ...base, messages: [firstUser] })) {
        if (event.type === "done") first = event.result;
      }
    } else first = await adapter.turn({ ...base, messages: [firstUser] });
    await adapter.turn({ ...base, messages: [firstUser, first.message, { role: "user", content: [{ type: "tool_result", toolCallId: "call_fixture", output: "sample" }] }] });
    assert.deepEqual(requests[1].input.slice(1), [
      reasoning,
      { role: "assistant", phase: "commentary", content: "Checking the value." },
      { role: "assistant", phase: "final_answer", content: "Here is the value." },
      { type: "function_call", call_id: "call_fixture", name: "capture_value", arguments: '{"value":"sample"}' },
      { type: "function_call_output", call_id: "call_fixture", output: "sample" }
    ]);
    assert.equal(requests[0].store, false);
    assert.equal(requests[1].store, false);
  });
}

test("assistant phase survives normalization and cannot label user content", () => {
  assert.deepEqual(normalizeChatMessages([{ role: "assistant", content: [{ type: "text", text: "Working", phase: "commentary" }] }])[0].content[0], { type: "text", text: "Working", phase: "commentary" });
  assert.throws(() => normalizeChatMessages([{ role: "user", content: [{ type: "text", text: "Question", phase: "commentary" }] }]), /phase can only appear in an assistant/);
});

test("Sonnet pricing and adaptive chat controls remain available", () => {
  const price = snapshotModelPricing({ provider: "anthropic", model: "claude-sonnet-5", at: "2026-09-23", tokenUsage: { inputTokens: 1000000, uncachedInputTokens: 1000000, outputTokens: 1000000 } });
  // https://platform.claude.com/docs/en/models/overview, checked 2026-09-23.
  assert.equal(price.rates.uncachedInput, 2);
  assert.equal(price.rates.output, 10);
  assert.equal(price.estimatedCostUsd, 12);
  assert.equal(resolveModelProfile({ provider: "anthropic", model: "claude-sonnet-5", profileId: "anthropic/claude-sonnet-5-chat" }).thinking.type, "adaptive");
});
