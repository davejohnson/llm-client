const test = require("node:test");
const assert = require("node:assert/strict");
const { callChatTurn, callText, normalizeSystem, streamChatTurn } = require("..");

test("system prompts normalize string arrays and discard empty text blocks", () => {
  assert.deepEqual(normalizeSystem(["First", " ", { type: "text", text: "Second" }, null]), [
    { type: "text", text: "First" },
    { type: "text", text: "Second" }
  ]);
  assert.deepEqual(normalizeSystem(), []);
  assert.equal(normalizeSystem("Help."), "Help.");
});

test("chat messages normalize Anthropic mid-conversation system controls", async () => {
  const adapter = {
    provider: "anthropic",
    turn: async (params) => ({
      message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
      stopReason: "end_turn",
      tokenUsage: null,
      observedMessages: params.messages
    })
  };
  const messages = [
    { role: "user", content: "Plan the migration." },
    { role: "assistant", content: "Here is the plan." },
    { role: "system", content: [], outputConfig: { effort: "low" } },
    {
      role: "system",
      content: "Only summarize on this turn.",
      clearAt: "next_user_message"
    },
    { role: "user", content: "Summarize it." }
  ];

  const result = await callChatTurn({
    adapter,
    provider: "anthropic",
    model: "claude-fable-5-1",
    messages,
    maxOutputTokens: 2048
  });

  assert.deepEqual(result.observedMessages[2], {
    role: "system",
    content: [],
    outputConfig: { effort: "low" }
  });
  assert.deepEqual(result.observedMessages[3], {
    role: "system",
    content: [{ type: "text", text: "Only summarize on this turn." }],
    clearAt: "next_user_message"
  });
});

test("chat turns pass normalized messages and reviewed model controls to the adapter", async () => {
  let request;
  const adapter = {
    provider: "openai",
    turn: async (params) => {
      request = params;
      return {
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
        stopReason: "end_turn",
        tokenUsage: {
          inputTokens: 10,
          uncachedInputTokens: 10,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          cacheWrite5mInputTokens: 0,
          cacheWrite1hInputTokens: 0,
          outputTokens: 2,
          reasoningOutputTokens: 0,
          totalTokens: 12
        },
        requestTelemetry: {
          providerRequestId: "req_chat",
          retryCount: 0,
          attempts: []
        }
      };
    }
  };

  const result = await callChatTurn({
    adapter,
    provider: "openai",
    model: "gpt-5.4-mini",
    system: "Help the user.",
    messages: [{ role: "user", content: "Check the roof." }],
    tools: [{
      name: "find_work_orders",
      description: "Find matching work orders.",
      strict: true,
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false
      }
    }],
    toolChoice: { type: "tool", name: "find_work_orders" },
    parallelToolCalls: false,
    maxOutputTokens: 2048,
    promptCacheKey: "property-chat-v1"
  });

  assert.deepEqual(request.messages, [{
    role: "user",
    content: [{ type: "text", text: "Check the roof." }]
  }]);
  assert.equal(request.tools[0].inputSchema.type, "object");
  assert.equal(request.tools[0].strict, true);
  assert.deepEqual(request.toolChoice, { type: "tool", name: "find_work_orders" });
  assert.equal(request.parallelToolCalls, false);
  assert.equal(request.maxOutputTokens, 2048);
  assert.equal(request.reasoningEffort, "none");
  assert.equal(request.promptCacheKey, "property-chat-v1");
  assert.equal(result.profile.id, "openai/gpt-5.4-mini");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.telemetry.providerRequestId, "req_chat");
  assert.equal(result.telemetry.pricing.available, true);
});

test("chat turns pass normalized Meta web-search controls to the adapter", async () => {
  let request;
  const adapter = {
    provider: "meta",
    turn: async (params) => {
      request = params;
      return {
        message: { role: "assistant", content: [{ type: "text", text: "Grounded." }] },
        stopReason: "end_turn",
        tokenUsage: null
      };
    }
  };

  const result = await callText({
    adapter,
    provider: "meta",
    model: "muse-spark-1.3",
    prompt: "What changed today?",
    maxOutputTokens: 1024,
    webSearch: { searchContextSize: "high" }
  });

  assert.deepEqual(request.webSearch, { searchContextSize: "high" });
  assert.deepEqual(request.toolChoice, { type: "auto" });
  assert.equal(request.reasoningEffort, "high");
  assert.equal(result.text, "Grounded.");
  await assert.rejects(() => callText({
    adapter,
    provider: "meta",
    model: "muse-spark-1.3",
    prompt: "Hello.",
    maxOutputTokens: 100,
    webSearch: { searchContextSize: "huge" }
  }), /searchContextSize/);
});

test("chat turns reject unsafe output budgets and invalid tool controls", async () => {
  const adapter = { provider: "openai", turn: async () => ({}) };
  const base = {
    adapter,
    provider: "openai",
    model: "gpt-5.4-mini",
    messages: [{ role: "user", content: "Hello." }],
    maxOutputTokens: 2048
  };

  await assert.rejects(() => callChatTurn({ ...base, maxOutputTokens: 0 }), /positive integer/);
  await assert.rejects(() => callChatTurn({
    ...base,
    tools: [{
      name: "search",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    }],
    toolChoice: { type: "tool", name: "missing" }
  }), /unknown tool/);
  await assert.rejects(() => callChatTurn({
    ...base,
    tools: [{
      name: "search",
      strict: "yes",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    }]
  }), /tools\[0\]\.strict must be a boolean/);
  await assert.rejects(() => callChatTurn({
    ...base,
    messages: [{
      role: "user",
      content: [{ type: "tool_call", id: "call_1", name: "search", input: {} }]
    }]
  }), /assistant message/);
  await assert.rejects(() => callChatTurn({
    ...base,
    maxOutputTokens: 128001
  }), /reviewed model limit/);
  await assert.rejects(() => callChatTurn({
    ...base,
    messages: [{
      role: "user",
      content: [{
        type: "reasoning",
        provider: "anthropic",
        data: { type: "thinking", thinking: "", signature: "sig" }
      }]
    }]
  }), /assistant message/);
  await assert.rejects(() => callChatTurn({
    ...base,
    messages: [{
      role: "assistant",
      content: [{ type: "reasoning", provider: "anthropic", data: null }]
    }]
  }), /opaque provider reasoning block/);
  await assert.rejects(() => callChatTurn({
    ...base,
    messages: [{ role: "user", content: [], outputConfig: { effort: "low" } }]
  }), /only supported on system messages/);
  await assert.rejects(() => callChatTurn({
    ...base,
    messages: [{ role: "system", content: [], outputConfig: { effort: "extreme" } }]
  }), /outputConfig\.effort/);
  await assert.rejects(() => callChatTurn({
    ...base,
    messages: [{ role: "system", content: "Temporary.", clearAt: "next_turn" }]
  }), /clearAt/);
});

test("chat turns preserve opaque provider reasoning for same-provider replay", async () => {
  let request;
  const reasoningData = {
    type: "thinking",
    thinking: "",
    signature: "sig_preserve_exactly"
  };
  const adapter = {
    provider: "anthropic",
    turn: async (params) => {
      request = params;
      return {
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
        stopReason: "end_turn",
        tokenUsage: null
      };
    }
  };

  const result = await callChatTurn({
    adapter,
    provider: "anthropic",
    model: "claude-sonnet-5",
    profileId: "anthropic/claude-sonnet-5-chat",
    system: "Use tools when needed.",
    messages: [
      { role: "user", content: "Check the roof." },
      {
        role: "assistant",
        content: [
          { type: "reasoning", provider: "anthropic", data: reasoningData },
          { type: "tool_call", id: "toolu_1", name: "search", input: { query: "roof" } }
        ]
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolCallId: "toolu_1", output: { matches: 2 } }]
      }
    ],
    tools: [{
      name: "search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false
      }
    }],
    toolChoice: "auto",
    maxOutputTokens: 2048
  });

  assert.strictEqual(request.messages[1].content[0].data, reasoningData);
  assert.deepEqual(request.thinking, { type: "adaptive" });
  assert.equal(result.profile.id, "anthropic/claude-sonnet-5-chat");
});

test("text calls return joined assistant text with the same telemetry envelope", async () => {
  const adapter = {
    provider: "anthropic",
    turn: async () => ({
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "First" },
          { type: "text", text: " second." }
        ]
      },
      stopReason: "end_turn",
      tokenUsage: null
    })
  };

  const result = await callText({
    adapter,
    provider: "anthropic",
    model: "claude-haiku-4-5",
    system: "Answer briefly.",
    prompt: "Hello.",
    maxOutputTokens: 100
  });

  assert.equal(result.text, "First second.");
  assert.equal(result.profile.id, "anthropic/claude-haiku-4-5");
  assert.equal(result.telemetry.provider, "anthropic");
});

test("streaming chat turns emit normalized deltas and a telemetry-bearing result", async () => {
  const adapter = {
    provider: "anthropic",
    async *streamTurn() {
      yield { type: "text_delta", text: "Hel" };
      yield { type: "text_delta", text: "lo" };
      yield {
        type: "done",
        result: {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello" }]
          },
          stopReason: "end_turn",
          tokenUsage: null,
          requestTelemetry: {
            providerRequestId: "req_stream",
            retryCount: 0,
            attempts: []
          }
        }
      };
    }
  };

  const events = [];
  for await (const event of streamChatTurn({
    adapter,
    provider: "anthropic",
    model: "claude-haiku-4-5",
    system: "Help.",
    messages: [{ role: "user", content: "Hello." }],
    maxOutputTokens: 100
  })) {
    events.push(event);
  }

  assert.deepEqual(events.slice(0, 2), [
    { type: "text_delta", text: "Hel" },
    { type: "text_delta", text: "lo" }
  ]);
  assert.equal(events[2].type, "done");
  assert.equal(events[2].result.message.content[0].text, "Hello");
  assert.equal(events[2].result.telemetry.providerRequestId, "req_stream");
  assert.equal(events[2].result.profile.id, "anthropic/claude-haiku-4-5");
});
