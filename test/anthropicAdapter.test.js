const test = require("node:test");
const assert = require("node:assert/strict");
const { createAnthropicAdapter } = require("..");

test("Anthropic adapter sends a native PDF, strict schema, effort, thinking, and cache controls", async () => {
  let request;
  const adapter = createAnthropicAdapter({ client: { messages: { create: async (params) => {
    request = params;
    return {
      model: "claude-opus-4-8",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "extract", input: { assets: [] } }],
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_creation: {
          ephemeral_5m_input_tokens: 20,
          ephemeral_1h_input_tokens: 0
        },
        cache_read_input_tokens: 80,
        output_tokens: 10,
        output_tokens_details: { thinking_tokens: 2 }
      }
    };
  } } } });
  const result = await adapter.call({
    model: "claude-opus-4-8",
    maxOutputTokens: 16000,
    system: "Read this.",
    userBlocks: [
      { type: "document", filename: "a.pdf", mediaType: "application/pdf", dataBase64: "cGRm" },
      { type: "image", mediaType: "image/png", dataBase64: "aW1n" }
    ],
    tool: { name: "extract", input_schema: { type: "object" } },
    effort: "medium",
    thinking: { type: "disabled" }
  });
  assert.deepEqual(request.messages[0].content[0], { type: "document", source: { type: "base64", media_type: "application/pdf", data: "cGRm" } });
  assert.deepEqual(request.messages[0].content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1n" } });
  assert.deepEqual(request.system[0].cache_control, { type: "ephemeral", ttl: "5m" });
  assert.equal(request.tools[0].strict, true);
  assert.deepEqual(request.output_config, { effort: "medium" });
  assert.deepEqual(request.thinking, { type: "disabled" });
  assert.deepEqual(result.output, { assets: [] });
  assert.deepEqual(result.tokenUsage, {
    inputTokens: 200,
    uncachedInputTokens: 100,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 20,
    cacheWrite5mInputTokens: 20,
    cacheWrite1hInputTokens: 0,
    outputTokens: 10,
    reasoningOutputTokens: 2,
    totalTokens: 210
  });
});

test("Anthropic adapter keeps plain-text documents as text sources", async () => {
  let request;
  const neutralText = "## Sheet: Maintenance Log\nItem,Cost\nBoiler service,450";
  const existingTextSource = {
    type: "document",
    source: {
      type: "text",
      media_type: "text/plain",
      data: "Existing plain-text source."
    }
  };
  const adapter = createAnthropicAdapter({
    apiKey: "test",
    client: {
      messages: {
        create: async (params) => {
          request = params;
          return { content: [{ type: "tool_use", name: "extract", input: {} }] };
        }
      }
    }
  });

  await adapter.call({
    model: "claude-sonnet-5",
    maxOutputTokens: 100,
    system: "Read.",
    userBlocks: [
      {
        type: "document",
        filename: "budget.xlsx",
        mediaType: "text/plain",
        dataBase64: Buffer.from(neutralText, "utf8").toString("base64")
      },
      existingTextSource
    ],
    tool: { name: "extract", input_schema: { type: "object" } }
  });

  assert.deepEqual(request.messages[0].content, [
    {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: neutralText }
    },
    existingTextSource
  ]);
});

test("Anthropic adapter caches the last system text block with a configurable TTL", async () => {
  let request;
  const adapter = createAnthropicAdapter({
    cacheTtl: "1h",
    client: { messages: { create: async (params) => {
      request = params;
      return { content: [{ type: "tool_use", name: "extract", input: {} }] };
    } } }
  });
  await adapter.call({
    model: "claude-sonnet-5",
    maxOutputTokens: 100,
    system: [{ type: "text", text: "First." }, { type: "text", text: "Second." }],
    userBlocks: [{ type: "text", text: "Extract." }],
    tool: { name: "extract", input_schema: { type: "object" } }
  });
  assert.equal(request.system[0].cache_control, undefined);
  assert.deepEqual(request.system[1].cache_control, { type: "ephemeral", ttl: "1h" });
});

test("Anthropic adapter can force a named document tool without strict grammar compilation", async () => {
  let request;
  const adapter = createAnthropicAdapter({
    strictDocumentTools: false,
    client: { messages: { create: async (params) => {
      request = params;
      return {
        content: [{ type: "tool_use", name: "extract", input: { confidence: 0.8 } }]
      };
    } } }
  });

  await adapter.call({
    model: "claude-sonnet-5",
    maxOutputTokens: 100,
    system: "Read.",
    userBlocks: [{ type: "text", text: "Extract." }],
    tool: {
      name: "extract",
      input_schema: {
        type: "object",
        properties: {
          confidence: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["confidence"],
        additionalProperties: false
      }
    }
  });

  assert.equal(Object.hasOwn(request.tools[0], "strict"), false);
  assert.deepEqual(request.tool_choice, {
    type: "tool",
    name: "extract",
    disable_parallel_tool_use: true
  });

  await adapter.turn({
    model: "claude-sonnet-5",
    maxOutputTokens: 100,
    system: "Help.",
    messages: [{ role: "user", content: "Look up the document." }],
    tools: [{
      name: "lookup",
      inputSchema: { type: "object", additionalProperties: false }
    }],
    toolChoice: { type: "tool", name: "lookup" }
  });
  assert.equal(request.tools[0].strict, true);
});

test("Anthropic 5.1 structured calls use strict automatic tools because forced tools are unsupported", async () => {
  const requests = [];
  const adapter = createAnthropicAdapter({
    client: { messages: { create: async (params) => {
      requests.push(params);
      return {
        model: params.model,
        stop_reason: "tool_use",
        content: [{ type: "tool_use", name: "extract", input: { total: 42 } }]
      };
    } } }
  });

  for (const model of ["claude-fable-5-1", "claude-mythos-5-1"]) {
    const result = await adapter.call({
      model,
      maxOutputTokens: 16000,
      system: "Use the extract tool to return the result.",
      userBlocks: [{ type: "text", text: "Extract this invoice." }],
      tool: {
        name: "extract",
        input_schema: {
          type: "object",
          properties: { total: { type: "number" } },
          required: ["total"],
          additionalProperties: false
        }
      },
      effort: "high",
      thinking: { type: "adaptive" }
    });
    assert.deepEqual(result.output, { total: 42 });
  }

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.deepEqual(request.tool_choice, {
      type: "auto",
      disable_parallel_tool_use: true
    });
    assert.equal(request.tools[0].strict, true);
    assert.deepEqual(request.thinking, { type: "adaptive" });
  }
});

test("Anthropic 5.1 chat rejects required and named tool choices before sending", async () => {
  let calls = 0;
  const adapter = createAnthropicAdapter({
    client: { messages: { create: async () => {
      calls += 1;
      return { content: [] };
    } } }
  });
  const base = {
    model: "claude-fable-5-1",
    maxOutputTokens: 100,
    system: "Help.",
    messages: [{ role: "user", content: "Use the lookup tool." }],
    tools: [{
      name: "lookup",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    }]
  };

  await assert.rejects(() => adapter.turn({ ...base, toolChoice: "required" }), /does not support required or named toolChoice/);
  await assert.rejects(() => adapter.turn({
    ...base,
    model: "claude-mythos-5-1",
    toolChoice: { type: "tool", name: "lookup" }
  }), /does not support required or named toolChoice/);
  assert.equal(calls, 0);
});

test("Anthropic adapter owns retries and makes every SDK attempt observable", async () => {
  let calls = 0;
  const options = [];
  const sleeps = [];
  const adapter = createAnthropicAdapter({
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
    client: { messages: { create: async (_params, requestOptions) => {
      calls += 1;
      options.push(requestOptions);
      if (calls < 3) {
        const error = new Error("busy");
        error.status = 503;
        error.request_id = `req_failed_${calls}`;
        error.headers = { "retry-after": "0" };
        throw error;
      }
      return {
        _request_id: "req_success",
        content: [{ type: "tool_use", name: "extract", input: { ok: true } }]
      };
    } } }
  });
  const result = await adapter.call({
    model: "claude-opus-4-8",
    maxOutputTokens: 100,
    system: "Read.",
    userBlocks: [{ type: "text", text: "Extract." }],
    tool: { name: "extract", input_schema: { type: "object" } }
  });
  assert.equal(calls, 3);
  assert.deepEqual(options, [
    { maxRetries: 0, timeout: 600000 },
    { maxRetries: 0, timeout: 600000 },
    { maxRetries: 0, timeout: 600000 }
  ]);
  assert.deepEqual(sleeps, [0, 0]);
  assert.equal(result.requestTelemetry.retryCount, 2);
  assert.equal(result.requestTelemetry.providerRequestId, "req_success");
  assert.deepEqual(
    result.requestTelemetry.attempts.map((attempt) => ({
      outcome: attempt.outcome,
      statusCode: attempt.statusCode,
      providerRequestId: attempt.providerRequestId,
      retryDelayMs: attempt.retryDelayMs
    })),
    [
      { outcome: "retryable_error", statusCode: 503, providerRequestId: "req_failed_1", retryDelayMs: 0 },
      { outcome: "retryable_error", statusCode: 503, providerRequestId: "req_failed_2", retryDelayMs: 0 },
      { outcome: "success", statusCode: null, providerRequestId: "req_success", retryDelayMs: null }
    ]
  );
  assert.throws(() => createAnthropicAdapter({ cacheTtl: "2h", client: {} }), /cacheTtl/);
});

test("Anthropic adapter classifies credit exhaustion without leaking its error shape", async () => {
  const providerError = Object.assign(new Error("BadRequestError"), {
    status: 400,
    request_id: "req_credit",
    error: {
      error: {
        type: "invalid_request_error",
        message: "Your credit balance is too low to access the Anthropic API."
      }
    }
  });
  const adapter = createAnthropicAdapter({
    maxRetries: 0,
    client: { messages: { create: async () => { throw providerError; } } }
  });

  await assert.rejects(() => adapter.call({
    model: "claude-sonnet-5",
    maxOutputTokens: 100,
    system: "Extract.",
    userBlocks: [{ type: "text", text: "Invoice" }],
    tool: { name: "extract", input_schema: { type: "object" } }
  }), (error) => {
    assert.deepEqual(error.providerError, {
      provider: "anthropic",
      category: "credit_exhausted",
      requestId: "req_credit"
    });
    return true;
  });
});

test("Anthropic chat turns translate neutral tool history and responses", async () => {
  let request;
  const adapter = createAnthropicAdapter({
    client: {
      messages: {
        create: async (params) => {
          request = params;
          return {
            id: "msg_123",
            model: "claude-sonnet-5",
            stop_reason: "tool_use",
            content: [
              { type: "text", text: "I found another record." },
              {
                type: "tool_use",
                id: "toolu_2",
                name: "search_records",
                input: { query: "roof" }
              }
            ],
            usage: { input_tokens: 40, output_tokens: 10 }
          };
        }
      }
    }
  });

  const result = await adapter.turn({
    model: "claude-sonnet-5",
    maxOutputTokens: 2048,
    system: "Help with property records.",
    messages: [
      { role: "user", content: "Find roof work." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll check." },
          { type: "tool_call", id: "toolu_1", name: "search_records", input: { query: "roof" } }
        ]
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          toolCallId: "toolu_1",
          output: { matches: 2 },
          isError: false
        }]
      }
    ],
    tools: [{
      name: "search_records",
      description: "Search property records.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false
      }
    }],
    toolChoice: { type: "tool", name: "search_records" },
    parallelToolCalls: false,
    effort: "medium",
    thinking: { type: "disabled" }
  });

  assert.deepEqual(request.messages, [
    { role: "user", content: [{ type: "text", text: "Find roof work." }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I'll check." },
        { type: "tool_use", id: "toolu_1", name: "search_records", input: { query: "roof" } }
      ]
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: '{"matches":2}',
        is_error: false
      }]
    }
  ]);
  assert.equal(request.tools[0].strict, true);
  assert.deepEqual(request.tools[0].input_schema.required, ["query"]);
  assert.deepEqual(request.tool_choice, {
    type: "tool",
    name: "search_records",
    disable_parallel_tool_use: true
  });
  assert.deepEqual(request.output_config, { effort: "medium" });
  assert.deepEqual(request.thinking, { type: "disabled" });
  assert.deepEqual(result.message, {
    role: "assistant",
    content: [
      { type: "text", text: "I found another record." },
      { type: "tool_call", id: "toolu_2", name: "search_records", input: { query: "roof" } }
    ]
  });
  assert.equal(result.stopReason, "tool_call");
  assert.equal(result.responseId, "msg_123");
  assert.equal(result.toolError, null);
});

test("Anthropic chat turns preserve and replay opaque thinking blocks", async () => {
  let request;
  const priorThinking = {
    type: "thinking",
    thinking: "",
    signature: "sig_prior"
  };
  const priorRedactedThinking = {
    type: "redacted_thinking",
    data: "redacted_prior"
  };
  const responseThinking = {
    type: "thinking",
    thinking: "",
    signature: "sig_response"
  };
  const responseRedactedThinking = {
    type: "redacted_thinking",
    data: "redacted_response"
  };
  const adapter = createAnthropicAdapter({
    client: {
      messages: {
        create: async (params) => {
          request = params;
          return {
            id: "msg_thinking",
            model: "claude-sonnet-5",
            stop_reason: "tool_use",
            content: [
              responseThinking,
              responseRedactedThinking,
              {
                type: "tool_use",
                id: "toolu_2",
                name: "search_records",
                input: { query: "roof" }
              }
            ]
          };
        }
      }
    }
  });

  const result = await adapter.turn({
    model: "claude-sonnet-5",
    maxOutputTokens: 2048,
    system: "Help with property records.",
    messages: [
      { role: "user", content: "Find roof work." },
      {
        role: "assistant",
        content: [
          { type: "reasoning", provider: "anthropic", data: priorThinking },
          { type: "reasoning", provider: "anthropic", data: priorRedactedThinking },
          { type: "tool_call", id: "toolu_1", name: "search_records", input: { query: "roof" } }
        ]
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolCallId: "toolu_1", output: { matches: 2 } }]
      }
    ],
    tools: [{
      name: "search_records",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false
      }
    }],
    toolChoice: "auto",
    effort: "medium",
    thinking: { type: "adaptive" }
  });

  assert.strictEqual(request.messages[1].content[0], priorThinking);
  assert.strictEqual(request.messages[1].content[1], priorRedactedThinking);
  assert.deepEqual(request.thinking, { type: "adaptive" });
  assert.deepEqual(result.message.content, [
    { type: "reasoning", provider: "anthropic", data: responseThinking },
    { type: "reasoning", provider: "anthropic", data: responseRedactedThinking },
    {
      type: "tool_call",
      id: "toolu_2",
      name: "search_records",
      input: { query: "roof" }
    }
  ]);
  assert.strictEqual(result.message.content[0].data, responseThinking);
  assert.strictEqual(result.message.content[1].data, responseRedactedThinking);
});

test("Anthropic 5.1 beta controls translate system messages and expose response metadata", async () => {
  let request;
  const inputTransformations = [{
    type: "thinking_dropped",
    path: "messages.1.content.0",
    reason: "prefix_binding_mismatch"
  }];
  const stopDetails = { type: "refusal", category: "cyber" };
  const adapter = createAnthropicAdapter({
    thinkingDisplay: "updates",
    thinkingPrefixMismatchBehavior: "drop_block",
    client: {
      beta: {
        messages: {
          create: async (params) => {
            request = params;
            return {
              id: "msg_beta",
              model: "claude-fable-5-1",
              stop_reason: "refusal",
              stop_details: stopDetails,
              input_transformations: inputTransformations,
              content: [{
                type: "thinking",
                thinking: "Checked the migration history.",
                signature: "sig_update"
              }]
            };
          }
        }
      }
    }
  });

  const result = await adapter.turn({
    model: "claude-fable-5-1",
    maxOutputTokens: 2048,
    system: "Help.",
    messages: [
      { role: "user", content: "Plan the migration." },
      { role: "assistant", content: "Here is the plan." },
      { role: "system", content: [], outputConfig: { effort: "low" } },
      {
        role: "system",
        content: "Only summarize on this turn.",
        clearAt: "next_user_message"
      },
      { role: "user", content: "Summarize it." }
    ],
    effort: "high",
    thinking: { type: "adaptive" }
  });

  assert.deepEqual(request.betas, [
    "thinking-display-updates-2026-08-18",
    "thinking-binding-controls-2026-08-01",
    "mid-conversation-output-config-2026-07-01",
    "mid-conversation-system-clear-at-2026-08-21"
  ]);
  assert.deepEqual(request.thinking, {
    type: "adaptive",
    display: "updates",
    block_binding: { prefix_mismatch_behavior: "drop_block" }
  });
  assert.deepEqual(request.messages[2], {
    role: "system",
    content: [],
    output_config: { effort: "low" }
  });
  assert.deepEqual(request.messages[3], {
    role: "system",
    content: [{ type: "text", text: "Only summarize on this turn." }],
    clear_at: "next_user_message"
  });
  assert.equal(result.stopReason, "refusal");
  assert.strictEqual(result.stopDetails, stopDetails);
  assert.strictEqual(result.inputTransformations, inputTransformations);
  assert.deepEqual(result.progressUpdates, ["Checked the migration history."]);

  assert.throws(
    () => createAnthropicAdapter({ thinkingDisplay: "raw", client: {} }),
    /thinkingDisplay/
  );
  assert.throws(
    () => createAnthropicAdapter({ thinkingPrefixMismatchBehavior: "ignore", client: {} }),
    /thinkingPrefixMismatchBehavior/
  );
});

test("Anthropic chat tools stay strict through 20 and become non-strict above the cap", async () => {
  const requests = [];
  const adapter = createAnthropicAdapter({
    client: {
      messages: {
        create: async (params) => {
          requests.push(params);
          return { content: [{ type: "text", text: "Done." }] };
        }
      }
    }
  });
  const tools = Array.from({ length: 38 }, (_, index) => ({
    name: `tool_${index + 1}`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }));
  const base = {
    model: "claude-sonnet-5",
    maxOutputTokens: 100,
    system: "Help.",
    messages: [{ role: "user", content: "Do the work." }],
    toolChoice: "auto"
  };

  await adapter.turn({ ...base, tools: tools.slice(0, 20) });
  await adapter.turn({ ...base, tools });

  assert.equal(requests[0].tools.length, 20);
  assert.ok(requests[0].tools.every((tool) => tool.strict === true));
  assert.equal(requests[1].tools.length, 38);
  assert.ok(requests[1].tools.every((tool) => !Object.hasOwn(tool, "strict")));
});

test("Anthropic chat tools honor an explicit strict subset above the total tool cap", async () => {
  let request;
  const adapter = createAnthropicAdapter({
    client: {
      messages: {
        create: async (params) => {
          request = params;
          return { content: [{ type: "text", text: "Done." }] };
        }
      }
    }
  });
  const tools = Array.from({ length: 32 }, (_, index) => ({
    name: `tool_${index + 1}`,
    strict: index < 20,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }));

  await adapter.turn({
    model: "claude-sonnet-5",
    maxOutputTokens: 100,
    system: "Help.",
    messages: [{ role: "user", content: "Do the work." }],
    tools,
    toolChoice: "auto"
  });

  assert.equal(request.tools.length, 32);
  assert.equal(request.tools.filter((tool) => tool.strict === true).length, 20);
  assert.deepEqual(
    request.tools.filter((tool) => tool.strict === true).map((tool) => tool.name),
    tools.slice(0, 20).map((tool) => tool.name)
  );
  assert.ok(request.tools.slice(20).every((tool) => !Object.hasOwn(tool, "strict")));
});

test("Anthropic chat tools fail closed to non-strict when an explicit subset exceeds 20", async () => {
  let request;
  const adapter = createAnthropicAdapter({
    client: {
      messages: {
        create: async (params) => {
          request = params;
          return { content: [{ type: "text", text: "Done." }] };
        }
      }
    }
  });
  const tools = Array.from({ length: 32 }, (_, index) => ({
    name: `tool_${index + 1}`,
    strict: index < 21,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }));

  await adapter.turn({
    model: "claude-sonnet-5",
    maxOutputTokens: 100,
    system: "Help.",
    messages: [{ role: "user", content: "Do the work." }],
    tools,
    toolChoice: "auto"
  });

  assert.ok(request.tools.every((tool) => !Object.hasOwn(tool, "strict")));
});

test("Anthropic chat tools fail closed when strict schemas exceed 24 optional parameters", async () => {
  const requests = [];
  const adapter = createAnthropicAdapter({
    client: {
      messages: {
        create: async (params) => {
          requests.push(params);
          return { content: [{ type: "text", text: "Done." }] };
        }
      }
    }
  });
  const strictTool = (optionalParameters) => ({
    name: `tool_with_${optionalParameters}_optional_parameters`,
    strict: true,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: optionalParameters }, (_, index) => [
          `optional_${index + 1}`,
          { type: "string" }
        ])
      ),
      additionalProperties: false
    }
  });
  const base = {
    model: "claude-sonnet-5",
    maxOutputTokens: 100,
    system: "Help.",
    messages: [{ role: "user", content: "Do the work." }],
    toolChoice: "auto"
  };

  await adapter.turn({ ...base, tools: [strictTool(24)] });
  await adapter.turn({ ...base, tools: [strictTool(25)] });

  assert.equal(requests[0].tools[0].strict, true);
  assert.equal(Object.hasOwn(requests[1].tools[0], "strict"), false);
});

test("Anthropic chat tools fail closed when strict schemas exceed 16 union parameters", async () => {
  const requests = [];
  const adapter = createAnthropicAdapter({
    client: {
      messages: {
        create: async (params) => {
          requests.push(params);
          return { content: [{ type: "text", text: "Done." }] };
        }
      }
    }
  });
  const strictTool = (unionParameters) => {
    const properties = Object.fromEntries(
      Array.from({ length: unionParameters }, (_, index) => [
        `union_${index + 1}`,
        { anyOf: [{ type: "integer" }, { type: "string" }] }
      ])
    );
    return {
      name: `tool_with_${unionParameters}_union_parameters`,
      strict: true,
      inputSchema: {
        type: "object",
        properties,
        required: Object.keys(properties),
        additionalProperties: false
      }
    };
  };
  const base = {
    model: "claude-sonnet-5",
    maxOutputTokens: 100,
    system: "Help.",
    messages: [{ role: "user", content: "Do the work." }],
    toolChoice: "auto"
  };

  await adapter.turn({ ...base, tools: [strictTool(16)] });
  await adapter.turn({ ...base, tools: [strictTool(17)] });

  assert.equal(requests[0].tools[0].strict, true);
  assert.equal(Object.hasOwn(requests[1].tools[0], "strict"), false);
});

test("Anthropic chat strict mode has an explicit adapter opt-out", async () => {
  let request;
  const adapter = createAnthropicAdapter({
    strictChatTools: false,
    client: {
      messages: {
        create: async (params) => {
          request = params;
          return { content: [{ type: "text", text: "Done." }] };
        }
      }
    }
  });

  await adapter.turn({
    model: "claude-sonnet-5",
    maxOutputTokens: 100,
    system: "Help.",
    messages: [{ role: "user", content: "Do the work." }],
    tools: [{
      name: "lookup",
      strict: true,
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    }],
    toolChoice: "auto"
  });

  assert.equal(Object.hasOwn(request.tools[0], "strict"), false);
  assert.throws(
    () => createAnthropicAdapter({ strictChatTools: "yes", client: {} }),
    /strictChatTools/
  );
});

test("Anthropic streaming chat turns emit neutral deltas and a normalized result", async () => {
  let request;
  const thinking = {
    type: "thinking",
    thinking: "",
    signature: "sig_stream"
  };
  const finalMessage = {
    id: "msg_stream",
    model: "claude-haiku-4-5",
    stop_reason: "tool_use",
    content: [
      thinking,
      { type: "text", text: "Checking." },
      {
        type: "tool_use",
        id: "toolu_stream",
        name: "search_records",
        input: { query: "roof" }
      }
    ],
    usage: { input_tokens: 20, output_tokens: 8 }
  };
  const clientStream = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Checking." }
      };
      yield {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_stream",
          name: "search_records",
          input: {}
        }
      };
      yield {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"query":"roof"}' }
      };
    },
    finalMessage: async () => finalMessage
  };
  const adapter = createAnthropicAdapter({
    client: {
      messages: {
        stream: (params) => {
          request = params;
          return clientStream;
        }
      }
    }
  });

  const events = [];
  for await (const event of adapter.streamTurn({
    model: "claude-haiku-4-5",
    maxOutputTokens: 100,
    system: "Help.",
    messages: [{ role: "user", content: "Find roof work." }],
    tools: [{
      name: "search_records",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false
      }
    }],
    toolChoice: "auto",
    parallelToolCalls: false
  })) {
    events.push(event);
  }

  assert.equal(request.model, "claude-haiku-4-5");
  assert.deepEqual(events.slice(0, 3), [
    { type: "text_delta", text: "Checking." },
    { type: "tool_call_start", id: "toolu_stream", name: "search_records" },
    {
      type: "tool_call_delta",
      id: "toolu_stream",
      inputJsonDelta: '{"query":"roof"}'
    }
  ]);
  assert.equal(events[3].type, "done");
  assert.deepEqual(events[3].result.message.content, [
    { type: "reasoning", provider: "anthropic", data: thinking },
    { type: "text", text: "Checking." },
    {
      type: "tool_call",
      id: "toolu_stream",
      name: "search_records",
      input: { query: "roof" }
    }
  ]);
  assert.equal(events[3].result.stopReason, "tool_call");
});

test("Anthropic streaming emits 5.1 progress updates from the beta Messages API", async () => {
  let request;
  const update = {
    type: "thinking",
    thinking: "Verified the failing retry path.",
    signature: "sig_progress"
  };
  const inputTransformations = [];
  const clientStream = {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: update.thinking }
      };
      yield {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Done." }
      };
    },
    finalMessage: async () => ({
      id: "msg_progress",
      model: "claude-fable-5-1",
      stop_reason: "end_turn",
      stop_details: null,
      input_transformations: inputTransformations,
      content: [update, { type: "text", text: "Done." }]
    })
  };
  const adapter = createAnthropicAdapter({
    thinkingDisplay: "updates",
    thinkingPrefixMismatchBehavior: "error",
    client: {
      beta: {
        messages: {
          stream: (params) => {
            request = params;
            return clientStream;
          }
        }
      }
    }
  });

  const events = [];
  for await (const event of adapter.streamTurn({
    model: "claude-fable-5-1",
    maxOutputTokens: 2048,
    system: "Fix the issue.",
    messages: [{ role: "user", content: "Investigate the retry failure." }],
    thinking: { type: "adaptive" }
  })) {
    events.push(event);
  }

  assert.deepEqual(request.betas, [
    "thinking-display-updates-2026-08-18",
    "thinking-binding-controls-2026-08-01"
  ]);
  assert.deepEqual(events.slice(0, 2), [
    { type: "progress_delta", text: "Verified the failing retry path." },
    { type: "text_delta", text: "Done." }
  ]);
  assert.equal(events[2].type, "done");
  assert.strictEqual(events[2].result.inputTransformations, inputTransformations);
  assert.deepEqual(events[2].result.progressUpdates, [update.thinking]);
});
