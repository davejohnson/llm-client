const test = require("node:test");
const assert = require("node:assert/strict");
const { createMetaAdapter } = require("..");

test("Meta adapter uses Responses JSON Schema output for Muse Spark document extraction", async () => {
  let requestUrl;
  let request;
  const adapter = createMetaAdapter({
    apiKey: "test",
    promptCacheRetention: "24h",
    fetchImpl: async (url, options) => {
      requestUrl = url;
      request = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => "req_meta_extract" },
        json: async () => ({
          id: "resp_meta_extract",
          model: "muse-spark-1.3",
          status: "completed",
          output: [
            {
              type: "reasoning",
              id: "rs_meta_extract",
              summary: [],
              encrypted_content: "encrypted_extract_reasoning"
            },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: '{"assets":[],"note":null}' }]
            }
          ],
          usage: {
            input_tokens: 120,
            input_tokens_details: { cached_tokens: 80 },
            output_tokens: 25,
            output_tokens_details: { reasoning_tokens: 10 },
            total_tokens: 145
          }
        })
      };
    }
  });

  const result = await adapter.call({
    model: "muse-spark-1.3",
    maxOutputTokens: 12000,
    system: "Extract the document.",
    userBlocks: [
      { type: "document", filename: "report.pdf", mediaType: "application/pdf", dataBase64: "cGRm" },
      { type: "text", text: "Return the assets." }
    ],
    tool: {
      name: "extract",
      description: "Return extracted fields.",
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
    reasoningEffort: "high",
    promptCacheKey: "document-extraction-v1"
  });

  assert.equal(requestUrl, "https://api.meta.ai/v1/responses");
  assert.equal(request.input[0].content[0].type, "input_file");
  assert.equal(request.input[0].content[0].detail, "low");
  assert.equal(Object.hasOwn(request, "tools"), false);
  assert.equal(Object.hasOwn(request, "tool_choice"), false);
  assert.deepEqual(request.reasoning, { effort: "high" });
  assert.deepEqual(request.include, ["reasoning.encrypted_content"]);
  assert.equal(request.store, false);
  assert.equal(request.prompt_cache_key, "document-extraction-v1");
  assert.equal(request.prompt_cache_retention, "24h");
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.name, "extract");
  assert.equal(request.text.format.strict, true);
  assert.deepEqual(request.text.format.schema.required, ["assets", "note"]);
  assert.deepEqual(request.text.format.schema.properties.note.type, ["string", "null"]);
  assert.deepEqual(result.output, { assets: [] });
  assert.equal(result.toolError, null);
  assert.equal(result.responseId, "resp_meta_extract");
  assert.equal(result.tokenUsage.cachedInputTokens, 80);
  assert.equal(result.tokenUsage.reasoningOutputTokens, 10);
});

test("Meta chat supports automatic functions, encrypted reasoning replay, and grounded search citations", async () => {
  let request;
  const priorReasoning = {
    type: "reasoning",
    id: "rs_prior",
    summary: [],
    encrypted_content: "encrypted_prior_reasoning"
  };
  const returnedReasoning = {
    type: "reasoning",
    id: "rs_next",
    summary: [],
    encrypted_content: "encrypted_next_reasoning"
  };
  const adapter = createMetaAdapter({
    apiKey: "test",
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => "req_meta_chat" },
        json: async () => ({
          id: "resp_meta_chat",
          model: "muse-spark-1.3",
          status: "completed",
          output: [
            returnedReasoning,
            { type: "web_search_call", id: "search_1", status: "completed" },
            {
              type: "message",
              role: "assistant",
              content: [{
                type: "output_text",
                text: "The filing was published today.",
                annotations: [{
                  type: "url_citation",
                  url: "https://example.com/filing",
                  title: "Company filing",
                  start_index: 0,
                  end_index: 31
                }]
              }]
            },
            {
              type: "function_call",
              call_id: "call_2",
              name: "save_filing",
              arguments: '{"url":"https://example.com/filing","tags":null}'
            }
          ],
          usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 }
        })
      };
    }
  });
  const tools = [{
    name: "save_filing",
    description: "Save a filing.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["url"],
      additionalProperties: false
    }
  }];

  const result = await adapter.turn({
    model: "muse-spark-1.3",
    maxOutputTokens: 2048,
    system: "Research current filings.",
    messages: [
      { role: "user", content: "Find the latest filing." },
      {
        role: "assistant",
        content: [
          { type: "reasoning", provider: "meta", data: priorReasoning },
          { type: "text", text: "I will search." }
        ]
      },
      { role: "system", content: "Prefer primary sources." },
      { role: "user", content: "Continue." }
    ],
    tools,
    toolChoice: "auto",
    parallelToolCalls: false,
    reasoningEffort: "high",
    webSearch: { searchContextSize: "high" }
  });

  assert.deepEqual(request.input[1], priorReasoning);
  assert.deepEqual(request.input[3], { role: "developer", content: "Prefer primary sources." });
  assert.equal(request.tools[0].type, "function");
  assert.deepEqual(request.tools[1], { type: "web_search", search_context_size: "high" });
  assert.equal(Object.hasOwn(request, "tool_choice"), false);
  assert.equal(request.parallel_tool_calls, false);
  assert.deepEqual(result.message.content[0], {
    type: "reasoning",
    provider: "meta",
    data: returnedReasoning
  });
  assert.deepEqual(result.message.content.at(-1), {
    type: "tool_call",
    id: "call_2",
    name: "save_filing",
    input: { url: "https://example.com/filing" }
  });
  assert.equal(result.stopReason, "tool_call");
  assert.deepEqual(result.citations, [{
    type: "url_citation",
    url: "https://example.com/filing",
    title: "Company filing",
    startIndex: 0,
    endIndex: 31,
    citedText: "The filing was published today."
  }]);
  assert.deepEqual(result.webSearchCalls, [
    { type: "web_search_call", id: "search_1", status: "completed" }
  ]);
});

test("Meta chat rejects unsupported forced tool choices without making a request", async () => {
  let calls = 0;
  const adapter = createMetaAdapter({
    apiKey: "test",
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ status: "completed", output: [] }) };
    }
  });
  const base = {
    model: "muse-spark-1.3",
    maxOutputTokens: 100,
    system: "Use tools.",
    messages: [{ role: "user", content: "Save this." }],
    tools: [{ name: "save", inputSchema: { type: "object" } }]
  };

  await assert.rejects(
    () => adapter.turn({ ...base, toolChoice: "required" }),
    /Muse Spark.*only supports automatic tool choice/i
  );
  await assert.rejects(
    () => adapter.turn({ ...base, toolChoice: { type: "tool", name: "save" } }),
    /Muse Spark.*only supports automatic tool choice/i
  );
  assert.equal(calls, 0);
});

test("Meta toolChoice none omits tools because the API rejects an explicit none choice", async () => {
  let request;
  const adapter = createMetaAdapter({
    apiKey: "test",
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }]
        })
      };
    }
  });

  await adapter.turn({
    model: "muse-spark-1.3",
    maxOutputTokens: 100,
    messages: [{ role: "user", content: "Answer without tools." }],
    tools: [{ name: "save", inputSchema: { type: "object" } }],
    toolChoice: "none",
    webSearch: true
  });

  assert.equal(Object.hasOwn(request, "tools"), false);
  assert.equal(Object.hasOwn(request, "tool_choice"), false);
});

test("Meta streaming emits normalized deltas and returns citations in the final result", async () => {
  const sse = [
    "event: response.output_text.delta",
    'data: {"type":"response.output_text.delta","delta":"Current."}',
    "",
    "event: response.completed",
    'data: {"type":"response.completed","response":{"id":"resp_stream","model":"muse-spark-1.3","status":"completed","output":[{"type":"web_search_call","id":"search_stream","status":"completed"},{"type":"message","content":[{"type":"output_text","text":"Current.","annotations":[{"type":"url_citation","url":"https://example.com/current","title":"Current source","start_index":0,"end_index":8}]}]}],"usage":{"input_tokens":20,"output_tokens":8}}}',
    "",
    ""
  ].join("\n");
  const adapter = createMetaAdapter({
    apiKey: "test",
    fetchImpl: async () => new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-request-id": "req_meta_stream" }
    })
  });

  const events = [];
  for await (const event of adapter.streamTurn({
    model: "muse-spark-1.3",
    maxOutputTokens: 100,
    messages: [{ role: "user", content: "What is current?" }],
    webSearch: true
  })) {
    events.push(event);
  }

  assert.deepEqual(events[0], { type: "text_delta", text: "Current." });
  assert.equal(events[1].type, "done");
  assert.equal(events[1].result.citations[0].url, "https://example.com/current");
  assert.equal(events[1].result.webSearchCalls[0].id, "search_stream");
  assert.equal(events[1].result.requestTelemetry.providerRequestId, "req_meta_stream");
});

test("Meta adapter reports provider-specific API errors", async () => {
  const adapter = createMetaAdapter({
    apiKey: "test",
    maxRetries: 0,
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      headers: { get: (name) => name === "x-request-id" ? "req_meta_bad" : null },
      json: async () => ({ error: { message: "bad request", type: "invalid_request_error" } })
    })
  });

  await assert.rejects(
    () => adapter.turn({
      model: "muse-spark-1.3",
      maxOutputTokens: 100,
      messages: [{ role: "user", content: "Hello." }]
    }),
    (error) => error.message.startsWith("Meta 400:")
      && error.providerError.provider === "meta"
      && error.providerError.requestId === "req_meta_bad"
  );
});
