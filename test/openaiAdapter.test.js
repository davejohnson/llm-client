const test = require("node:test");
const assert = require("node:assert/strict");
const { createOpenAIAdapter } = require("..");

test("OpenAI adapter sends native file input and parses a strict function call as tool arguments", async () => {
  let request;
  const adapter = createOpenAIAdapter({ apiKey: "test", fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body);
    assert.ok(options.signal);
    return {
      ok: true,
      json: async () => ({
        model: "gpt-5.4-mini",
        status: "completed",
        output: [{ type: "function_call", name: "extract", arguments: '{"assets":[],"note":null}' }],
        usage: {
          input_tokens: 120,
          input_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 5 },
          total_tokens: 140
        }
      })
    };
  } });
  const result = await adapter.call({
    model: "gpt-5.4-mini",
    maxOutputTokens: 12000,
    system: "Read this.",
    userBlocks: [
      { type: "document", filename: "a.pdf", mediaType: "application/pdf", dataBase64: "cGRm" },
      { type: "image", mediaType: "image/png", dataBase64: "aW1n" }
    ],
    tool: {
      name: "extract",
      description: "Extract",
      input_schema: {
        type: "object",
        properties: {
          assets: { type: "array" },
          note: { type: "string" }
        },
        required: ["assets"],
        additionalProperties: false
      }
    },
    reasoningEffort: "none",
    promptCacheKey: "invoice-v1"
  });
  assert.equal(request.input[0].content[0].type, "input_file");
  assert.match(request.input[0].content[0].file_data, /^data:application\/pdf;base64,/);
  assert.equal(request.input[0].content[0].detail, "low");
  assert.deepEqual(request.input[0].content[1], {
    type: "input_image",
    image_url: "data:image/png;base64,aW1n"
  });
  assert.equal(request.prompt_cache_key, "invoice-v1");
  assert.deepEqual(request.reasoning, { effort: "none" });
  assert.equal(request.tools[0].strict, true);
  assert.deepEqual(request.tools[0].parameters.required, ["assets", "note"]);
  assert.deepEqual(request.tools[0].parameters.properties.note.type, ["string", "null"]);
  assert.deepEqual(result.output, { assets: [] });
  assert.equal(result.toolError, null);
  assert.deepEqual(result.tokenUsage, {
    inputTokens: 120,
    uncachedInputTokens: 30,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 10,
    cacheWrite5mInputTokens: 0,
    cacheWrite1hInputTokens: 0,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    totalTokens: 140
  });
});

test("OpenAI adapter sends plain-text document sources as input_text", async () => {
  let request;
  const rawText = "Inspection notes\nBoiler service due annually.";
  const adapter = createOpenAIAdapter({
    apiKey: "test",
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          status: "completed",
          output: [{ type: "function_call", name: "extract", arguments: "{}" }]
        })
      };
    }
  });

  await adapter.call({
    model: "gpt-5.4-mini",
    maxOutputTokens: 100,
    system: "Read.",
    userBlocks: [{
      type: "document",
      filename: "notes.txt",
      source: { type: "text", media_type: "text/plain", data: rawText }
    }],
    tool: { name: "extract", input_schema: { type: "object" } }
  });

  assert.deepEqual(request.input[0].content[0], { type: "input_text", text: rawText });
  assert.doesNotMatch(JSON.stringify(request), new RegExp(`;base64,${rawText}`));
});

test("OpenAI adapter decodes an XLSX-derived neutral text chunk as input_text", async () => {
  let request;
  const flattenedSheet = "## Sheet: Maintenance Log\nItem,Cost\nBoiler service,450";
  const adapter = createOpenAIAdapter({
    apiKey: "test",
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          status: "completed",
          output: [{ type: "function_call", name: "extract", arguments: "{}" }]
        })
      };
    }
  });

  await adapter.call({
    model: "gpt-5.4-mini",
    maxOutputTokens: 100,
    system: "Read.",
    userBlocks: [{
      type: "document",
      filename: "budget.xlsx",
      mediaType: "text/plain",
      dataBase64: Buffer.from(flattenedSheet, "utf8").toString("base64")
    }],
    tool: { name: "extract", input_schema: { type: "object" } }
  });

  assert.deepEqual(request.input[0].content[0], {
    type: "input_text",
    text: flattenedSheet
  });
  assert.equal(Object.hasOwn(request.input[0].content[0], "file_data"), false);
});

test("OpenAI adapter maps a max-output incomplete response to max_tokens", async () => {
  const adapter = createOpenAIAdapter({
    apiKey: "test",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: []
      })
    })
  });

  const result = await adapter.call({
    model: "gpt-5.4-mini",
    maxOutputTokens: 12000,
    system: "Read.",
    userBlocks: [{ type: "text", text: "Extract." }],
    tool: { name: "extract", input_schema: { type: "object" } }
  });

  assert.equal(result.stopReason, "max_tokens");
  assert.equal(result.output, null);
  assert.equal(result.toolError, null);
});

test("OpenAI adapter recognizes truncated function arguments without incomplete_details", async () => {
  const adapter = createOpenAIAdapter({
    apiKey: "test",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        status: "completed",
        output: [{ type: "function_call", name: "extract", arguments: '{"assets":[' }]
      })
    })
  });

  const result = await adapter.call({
    model: "gpt-5.4-mini",
    maxOutputTokens: 12000,
    system: "Read.",
    userBlocks: [{ type: "text", text: "Extract." }],
    tool: { name: "extract", input_schema: { type: "object" } }
  });

  assert.equal(result.stopReason, "max_tokens");
  assert.equal(result.toolError, null);
});

test("OpenAI adapter still surfaces complete malformed function arguments", async () => {
  const adapter = createOpenAIAdapter({
    apiKey: "test",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        status: "completed",
        output: [{ type: "function_call", name: "extract", arguments: '{"assets": nope}' }]
      })
    })
  });

  const result = await adapter.call({
    model: "gpt-5.4-mini",
    maxOutputTokens: 12000,
    system: "Read.",
    userBlocks: [{ type: "text", text: "Extract." }],
    tool: { name: "extract", input_schema: { type: "object" } }
  });

  assert.equal(result.stopReason, "completed");
  assert.match(result.toolError.message, /invalid arguments/);
});

test("OpenAI adapter retries bounded transient failures and honors PDF detail overrides", async () => {
  const statuses = [429, 503, 200];
  const sleeps = [];
  let cancelledBodies = 0;
  let calls = 0;
  const adapter = createOpenAIAdapter({
    apiKey: "test",
    maxRetries: 2,
    pdfDetail: "high",
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
    fetchImpl: async (_url, options) => {
      const status = statuses[calls++];
      const requestId = `req_${calls}`;
      const request = JSON.parse(options.body);
      assert.equal(request.input[0].content[0].detail, "high");
      return {
        ok: status === 200,
        status,
        statusText: "temporary",
        headers: { get: (name) => {
          if (name === "retry-after") return "0";
          if (name === "x-request-id") return requestId;
          return null;
        } },
        body: { cancel: async () => { cancelledBodies += 1; } },
        json: async () => status === 200
          ? { output: [{ type: "function_call", name: "extract", arguments: "{}" }] }
          : { error: { message: "temporary" } }
      };
    }
  });
  const result = await adapter.call({
    model: "gpt-5.4-mini",
    maxOutputTokens: 100,
    system: "Read.",
    userBlocks: [{ type: "document", mediaType: "application/pdf", dataBase64: "cGRm" }],
    pdfDetail: "low",
    tool: { name: "extract", input_schema: { type: "object" } }
  });
  assert.deepEqual(result.output, {});
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [0, 0]);
  assert.equal(cancelledBodies, 2);
  assert.equal(result.requestTelemetry.retryCount, 2);
  assert.equal(result.requestTelemetry.providerRequestId, "req_3");
  assert.deepEqual(
    result.requestTelemetry.attempts.map((attempt) => ({
      outcome: attempt.outcome,
      statusCode: attempt.statusCode,
      providerRequestId: attempt.providerRequestId,
      retryDelayMs: attempt.retryDelayMs
    })),
    [
      { outcome: "retryable_error", statusCode: 429, providerRequestId: "req_1", retryDelayMs: 0 },
      { outcome: "retryable_error", statusCode: 503, providerRequestId: "req_2", retryDelayMs: 0 },
      { outcome: "success", statusCode: 200, providerRequestId: "req_3", retryDelayMs: null }
    ]
  );
});

test("OpenAI adapter surfaces non-retryable API details", async () => {
  let calls = 0;
  const adapter = createOpenAIAdapter({
    apiKey: "test",
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        headers: { get: (name) => name === "x-request-id" ? "req_123" : null },
        json: async () => ({ error: { message: "bad schema", type: "invalid_request_error" } })
      };
    }
  });
  await assert.rejects(
    () => adapter.call({
      model: "gpt-5.4-mini",
      maxOutputTokens: 100,
      system: "Read.",
      userBlocks: [{ type: "text", text: "Extract." }],
      tool: { name: "extract", input_schema: { type: "object" } }
    }),
    (error) => error.status === 400
      && error.type === "invalid_request_error"
      && error.requestId === "req_123"
      && error.requestTelemetry.retryCount === 0
      && error.requestTelemetry.attempts[0].outcome === "error"
  );
  assert.equal(calls, 1);
});

test("OpenAI adapter classifies structured owner-action limits without retrying", async (t) => {
  const cases = [
    {
      name: "exhausted prepaid credits",
      status: 429,
      code: "credit_balance_exhausted",
      type: "insufficient_quota",
      category: "credit_exhausted",
      scope: "organization"
    },
    {
      name: "organization spend limit",
      status: 429,
      code: "organization_spend_limit_exceeded",
      type: "insufficient_quota",
      category: "spend_limit_exceeded",
      scope: "organization"
    },
    {
      name: "project spend limit",
      status: 429,
      code: "project_spend_limit_exceeded",
      type: "insufficient_quota",
      category: "spend_limit_exceeded",
      scope: "project"
    },
    {
      name: "organization usage limit",
      status: 429,
      code: "organization_usage_limit_exceeded",
      type: "insufficient_quota",
      category: "usage_limit_exceeded",
      scope: "organization"
    },
    {
      name: "input context limit",
      status: 400,
      code: "context_length_exceeded",
      type: "invalid_request_error",
      category: "context_limit_exceeded",
      scope: null
    }
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      let calls = 0;
      const adapter = createOpenAIAdapter({
        apiKey: "test",
        maxRetries: 2,
        sleepImpl: async () => {},
        fetchImpl: async () => {
          calls += 1;
          return {
            ok: false,
            status: item.status,
            statusText: "Request failed",
            headers: { get: (name) => name === "x-request-id" ? `req_${calls}` : null },
            json: async () => ({
              error: {
                message: "provider-specific prose that callers must not parse",
                type: item.type,
                code: item.code
              }
            })
          };
        }
      });

      await assert.rejects(() => adapter.call({
        model: "gpt-5.4-mini",
        maxOutputTokens: 100,
        system: "Read.",
        userBlocks: [{ type: "text", text: "Extract." }],
        tool: { name: "extract", input_schema: { type: "object" } }
      }), (error) => {
        assert.deepEqual(error.providerError, {
          provider: "openai",
          category: item.category,
          requestId: "req_1",
          code: item.code,
          type: item.type,
          statusCode: item.status,
          ...(item.scope ? { scope: item.scope } : {}),
          retryable: false
        });
        assert.equal(Object.hasOwn(error.providerError, "message"), false);
        assert.equal(error.requestTelemetry.retryCount, 0);
        assert.equal(error.requestTelemetry.attempts[0].outcome, "error");
        return true;
      });
      assert.equal(calls, 1);
    });
  }
});

test("OpenAI adapter reports ambiguous insufficient quota without inventing a billing cause", async () => {
  const adapter = createOpenAIAdapter({
    apiKey: "test",
    maxRetries: 2,
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: { get: () => null },
      json: async () => ({ error: { message: "quota unavailable", type: "insufficient_quota" } })
    })
  });

  await assert.rejects(() => adapter.call({
    model: "gpt-5.4-mini",
    maxOutputTokens: 100,
    system: "Read.",
    userBlocks: [{ type: "text", text: "Extract." }],
    tool: { name: "extract", input_schema: { type: "object" } }
  }), (error) => {
    assert.deepEqual(error.providerError, {
      provider: "openai",
      category: "quota_exhausted",
      requestId: null,
      type: "insufficient_quota",
      statusCode: 429,
      retryable: false
    });
    return true;
  });
});

test("OpenAI adapter keeps structured rate limits retryable", async () => {
  let calls = 0;
  const adapter = createOpenAIAdapter({
    apiKey: "test",
    maxRetries: 1,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: { get: (name) => name === "x-request-id" ? `req_rate_${calls}` : null },
        json: async () => ({
          error: { message: "slow down", type: "rate_limit_error", code: "slow_down" }
        })
      };
    }
  });

  await assert.rejects(() => adapter.call({
    model: "gpt-5.4-mini",
    maxOutputTokens: 100,
    system: "Read.",
    userBlocks: [{ type: "text", text: "Extract." }],
    tool: { name: "extract", input_schema: { type: "object" } }
  }), (error) => {
    assert.deepEqual(error.providerError, {
      provider: "openai",
      category: "rate_limited",
      requestId: "req_rate_2",
      code: "slow_down",
      type: "rate_limit_error",
      statusCode: 429,
      retryable: true
    });
    assert.equal(error.requestTelemetry.retryCount, 1);
    assert.deepEqual(
      error.requestTelemetry.attempts.map((attempt) => attempt.outcome),
      ["retryable_error", "retryable_error"]
    );
    return true;
  });
  assert.equal(calls, 2);
});

test("OpenAI adapter does not infer rate limiting from HTTP 429 alone", async () => {
  const adapter = createOpenAIAdapter({
    apiKey: "test",
    maxRetries: 0,
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: { get: () => null },
      json: async () => ({ error: { message: "ambiguous provider failure" } })
    })
  });

  await assert.rejects(() => adapter.call({
    model: "gpt-5.4-mini",
    maxOutputTokens: 100,
    system: "Read.",
    userBlocks: [{ type: "text", text: "Extract." }],
    tool: { name: "extract", input_schema: { type: "object" } }
  }), (error) => {
    assert.deepEqual(error.providerError, {
      provider: "openai",
      category: null,
      requestId: null,
      statusCode: 429,
      retryable: true
    });
    assert.equal(error.requestTelemetry.retryCount, 0);
    assert.equal(error.requestTelemetry.attempts[0].outcome, "retryable_error");
    return true;
  });
});

test("OpenAI chat turns translate neutral tool history and normalize strict tool calls", async () => {
  let request;
  const adapter = createOpenAIAdapter({
    apiKey: "test",
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          id: "resp_123",
          model: "gpt-5.4-mini",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "I found a match." }]
            },
            {
              type: "function_call",
              call_id: "call_2",
              name: "search_records",
              arguments: '{"query":"roof","filters":null}'
            }
          ],
          usage: { input_tokens: 50, output_tokens: 12, total_tokens: 62 }
        })
      };
    }
  });

  const tools = [{
    name: "search_records",
    description: "Search property records.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        filters: {
          type: "object",
          properties: { status: { type: "string" } },
          additionalProperties: false
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  }];
  const result = await adapter.turn({
    model: "gpt-5.4-mini",
    maxOutputTokens: 2048,
    system: "Help with property records.",
    messages: [
      { role: "user", content: "Find roof work." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll check." },
          { type: "tool_call", id: "call_1", name: "search_records", input: { query: "roof" } }
        ]
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolCallId: "call_1", output: { matches: 2 } }]
      }
    ],
    tools,
    toolChoice: { type: "tool", name: "search_records" },
    parallelToolCalls: false,
    reasoningEffort: "none",
    promptCacheKey: "property-chat-v1"
  });

  assert.deepEqual(request.input, [
    { role: "user", content: [{ type: "input_text", text: "Find roof work." }] },
    { role: "assistant", content: "I'll check." },
    {
      type: "function_call",
      call_id: "call_1",
      name: "search_records",
      arguments: '{"query":"roof"}'
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: '{"matches":2}'
    }
  ]);
  assert.deepEqual(request.tool_choice, { type: "function", name: "search_records" });
  assert.equal(request.parallel_tool_calls, false);
  assert.equal(request.prompt_cache_key, "property-chat-v1");
  assert.deepEqual(request.reasoning, { effort: "none" });
  assert.deepEqual(request.tools[0].parameters.required, ["query", "filters"]);
  assert.deepEqual(request.tools[0].parameters.properties.filters.type, ["object", "null"]);
  assert.deepEqual(result.message, {
    role: "assistant",
    content: [
      { type: "text", text: "I found a match." },
      { type: "tool_call", id: "call_2", name: "search_records", input: { query: "roof" } }
    ]
  });
  assert.equal(result.stopReason, "tool_call");
  assert.equal(result.responseId, "resp_123");
  assert.equal(result.toolError, null);
});

test("OpenAI chat turns map text completion and truncated tool arguments", async () => {
  const responses = [
    {
      id: "resp_text",
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "The roof was repaired." }]
      }]
    },
    {
      id: "resp_partial",
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{
        type: "function_call",
        call_id: "call_partial",
        name: "search",
        arguments: '{"query":"roof"'
      }]
    }
  ];
  const adapter = createOpenAIAdapter({
    apiKey: "test",
    fetchImpl: async () => ({ ok: true, json: async () => responses.shift() })
  });
  const base = {
    model: "gpt-5.4-mini",
    maxOutputTokens: 2048,
    system: "Help.",
    messages: [{ role: "user", content: "What happened?" }],
    tools: [{
      name: "search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false
      }
    }]
  };

  const text = await adapter.turn({ ...base, toolChoice: "none" });
  assert.deepEqual(text.message.content, [{ type: "text", text: "The roof was repaired." }]);
  assert.equal(text.stopReason, "end_turn");

  const partial = await adapter.turn({ ...base, toolChoice: "auto" });
  assert.deepEqual(partial.message.content, []);
  assert.equal(partial.stopReason, "max_tokens");
  assert.equal(partial.toolError, null);
});

test("OpenAI streaming chat turns emit neutral deltas and a normalized result", async () => {
  const sse = [
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"Checking."}',
    "",
    'event: response.output_item.added',
    'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_stream","name":"search_records","arguments":""}}',
    "",
    'event: response.function_call_arguments.delta',
    'data: {"type":"response.function_call_arguments.delta","item_id":"call_stream","delta":"{\\"query\\":\\"roof\\"}"}',
    "",
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_stream","model":"gpt-5.4-mini","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Checking."}]},{"type":"function_call","call_id":"call_stream","name":"search_records","arguments":"{\\"query\\":\\"roof\\"}"}],"usage":{"input_tokens":20,"output_tokens":8}}}',
    "",
    ""
  ].join("\n");
  const adapter = createOpenAIAdapter({
    apiKey: "test",
    fetchImpl: async () => new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-request-id": "req_stream" }
    })
  });

  const events = [];
  for await (const event of adapter.streamTurn({
    model: "gpt-5.4-mini",
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
    parallelToolCalls: false,
    reasoningEffort: "none"
  })) {
    events.push(event);
  }

  assert.deepEqual(events.slice(0, 3), [
    { type: "text_delta", text: "Checking." },
    { type: "tool_call_start", id: "call_stream", name: "search_records" },
    {
      type: "tool_call_delta",
      id: "call_stream",
      inputJsonDelta: '{"query":"roof"}'
    }
  ]);
  assert.equal(events[3].type, "done");
  assert.equal(events[3].result.message.content[1].name, "search_records");
  assert.equal(events[3].result.requestTelemetry.providerRequestId, "req_stream");
});

test("OpenAI streaming startup classifies billing limits without retrying", async () => {
  let calls = 0;
  const adapter = createOpenAIAdapter({
    apiKey: "test",
    maxRetries: 2,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        error: {
          message: "billing copy can change",
          type: "insufficient_quota",
          code: "project_spend_limit_exceeded"
        }
      }), {
        status: 429,
        headers: { "content-type": "application/json", "x-request-id": "req_stream_spend" }
      });
    }
  });

  await assert.rejects(async () => {
    for await (const _event of adapter.streamTurn({
      model: "gpt-5.4-mini",
      maxOutputTokens: 100,
      system: "Help.",
      messages: [{ role: "user", content: "Hello." }]
    })) {}
  }, (error) => {
    assert.deepEqual(error.providerError, {
      provider: "openai",
      category: "spend_limit_exceeded",
      requestId: "req_stream_spend",
      code: "project_spend_limit_exceeded",
      type: "insufficient_quota",
      statusCode: 429,
      scope: "project",
      retryable: false
    });
    assert.equal(error.requestTelemetry.retryCount, 0);
    return true;
  });
  assert.equal(calls, 1);
});

test("OpenAI streaming events keep machine codes separate from provider prose", async () => {
  const sse = [
    "event: error",
    'data: {"type":"error","code":"credit_balance_exhausted","message":"billing copy can change","param":null}',
    "",
    ""
  ].join("\n");
  const adapter = createOpenAIAdapter({
    apiKey: "test",
    fetchImpl: async () => new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-request-id": "req_stream_credit" }
    })
  });

  await assert.rejects(async () => {
    for await (const _event of adapter.streamTurn({
      model: "gpt-5.4-mini",
      maxOutputTokens: 100,
      system: "Help.",
      messages: [{ role: "user", content: "Hello." }]
    })) {}
  }, (error) => {
    assert.deepEqual(error.providerError, {
      provider: "openai",
      category: "credit_exhausted",
      requestId: "req_stream_credit",
      code: "credit_balance_exhausted",
      scope: "organization",
      retryable: false
    });
    assert.equal(Object.hasOwn(error.providerError, "message"), false);
    assert.equal(error.requestTelemetry.attempts[0].outcome, "error");
    return true;
  });
});
