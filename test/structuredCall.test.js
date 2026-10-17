const test = require("node:test");
const assert = require("node:assert/strict");
const { callStructured } = require("..");

test("structured calls pass reviewed profile controls to the matching adapter", async () => {
  let request;
  const adapter = {
    provider: "anthropic",
    call: async (params) => {
      request = params;
      return { output: { total: 42 } };
    }
  };
  const result = await callStructured({
    adapter,
    provider: "anthropic",
    model: "claude-sonnet-5",
    system: "Extract.",
    userBlocks: [{ type: "text", text: "Invoice." }],
    tool: { name: "extract", input_schema: { type: "object" } }
  });
  assert.equal(request.effort, "medium");
  assert.deepEqual(request.thinking, { type: "disabled" });
  assert.equal(result.profile.model, "claude-sonnet-5");
});

test("structured calls normalize array system prompts before adapter translation", async () => {
  let request;
  await callStructured({
    adapter: {
      provider: "anthropic",
      call: async (params) => {
        request = params;
        return { output: {} };
      }
    },
    provider: "anthropic",
    model: "claude-sonnet-5",
    system: ["Extract.", ""],
    userBlocks: [{ type: "text", text: "Invoice." }],
    tool: { name: "extract", input_schema: { type: "object" } }
  });

  assert.deepEqual(request.system, [{ type: "text", text: "Extract." }]);
});

test("structured OpenAI calls pass the reviewed reasoning and output budget controls", async () => {
  let request;
  const adapter = {
    provider: "openai",
    call: async (params) => {
      request = params;
      return { output: { total: 42 } };
    }
  };
  await callStructured({
    adapter,
    provider: "openai",
    model: "gpt-5.6-terra",
    system: "Extract.",
    userBlocks: [{ type: "text", text: "Invoice." }],
    tool: { name: "extract", input_schema: { type: "object" } }
  });
  assert.equal(request.maxOutputTokens, 12000);
  assert.equal(request.reasoningEffort, "none");
  assert.equal(request.pdfDetail, "low");
});

test("structured calls accept a smaller per-call output budget", async () => {
  let request;
  const adapter = {
    provider: "anthropic",
    call: async (params) => {
      request = params;
      return { output: { total: 42 } };
    }
  };
  const result = await callStructured({
    adapter,
    provider: "anthropic",
    model: "claude-sonnet-5",
    maxOutputTokens: 1024,
    system: "Extract.",
    userBlocks: [{ type: "text", text: "Invoice." }],
    tool: { name: "extract", input_schema: { type: "object" } }
  });

  assert.equal(request.maxOutputTokens, 1024);
  assert.equal(result.profile.maxOutputTokens, 12000);
});

test("structured calls reject output budgets above the reviewed model limit", async () => {
  await assert.rejects(() => callStructured({
    adapter: { provider: "anthropic", call: async () => ({ output: {} }) },
    provider: "anthropic",
    model: "claude-haiku-4-5",
    maxOutputTokens: 64001,
    system: "Extract.",
    userBlocks: [{ type: "text", text: "Invoice." }],
    tool: { name: "extract", input_schema: { type: "object" } }
  }), /maxOutputTokens cannot exceed the reviewed model limit of 64000/);
});

test("structured calls reject provider mismatches and invalid cache keys", async () => {
  const adapter = { provider: "openai", call: async () => ({}) };
  const base = {
    adapter,
    provider: "anthropic",
    model: "claude-opus-4-8",
    system: "Extract.",
    userBlocks: [],
    tool: { name: "extract", input_schema: { type: "object" } }
  };
  await assert.rejects(() => callStructured(base), /does not match/);
  await assert.rejects(() => callStructured({
    ...base,
    provider: "openai",
    model: "gpt-5.4-mini",
    promptCacheKey: " "
  }), /promptCacheKey/);
});

test("structured calls flag provider tool input that violates the original schema", async () => {
  const result = await callStructured({
    adapter: {
      provider: "anthropic",
      call: async () => ({ output: { confidence: 1.2 } })
    },
    provider: "anthropic",
    model: "claude-sonnet-5",
    system: "Extract.",
    userBlocks: [{ type: "text", text: "Document." }],
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

  assert.equal(result.output.confidence, 1.2);
  assert.match(result.toolError.message, /invalid input.*extract/i);
  assert.match(result.toolError.message, /maximum/i);
});

test("structured calls return normalized request, token, and pricing telemetry", async () => {
  const tokenUsage = {
    inputTokens: 1100000,
    uncachedInputTokens: 1000000,
    cachedInputTokens: 100000,
    cacheWriteInputTokens: 0,
    outputTokens: 10000,
    reasoningOutputTokens: 0,
    totalTokens: 1110000
  };
  const attempts = [{
    attempt: 1,
    startedAt: "2026-07-17T00:00:00.000Z",
    endedAt: "2026-07-17T00:00:01.000Z",
    elapsedMs: 1000,
    outcome: "success",
    statusCode: 200,
    providerRequestId: "req_openai_1",
    errorType: null,
    retryDelayMs: null
  }];
  const result = await callStructured({
    adapter: {
      provider: "openai",
      call: async () => ({
        output: { total: 42 },
        tokenUsage,
        requestTelemetry: {
          elapsedMs: 1000,
          providerRequestId: "req_openai_1",
          retryCount: 0,
          attempts
        }
      })
    },
    provider: "openai",
    model: "gpt-5.4-mini",
    system: "Extract.",
    userBlocks: [{ type: "text", text: "Invoice." }],
    tool: { name: "extract", input_schema: { type: "object" } }
  });

  assert.equal(result.telemetry.schemaVersion, 1);
  assert.equal(result.telemetry.provider, "openai");
  assert.equal(result.telemetry.model, "gpt-5.4-mini");
  assert.equal(result.telemetry.profileId, "openai/gpt-5.4-mini");
  assert.deepEqual(result.telemetry.tokenUsage, tokenUsage);
  assert.equal(result.telemetry.providerRequestId, "req_openai_1");
  assert.equal(result.telemetry.retryCount, 0);
  assert.deepEqual(result.telemetry.attempts, attempts);
  assert.equal(result.telemetry.pricing.catalogVersion, "2026-10-07");
  assert.deepEqual(result.telemetry.pricing.rates, {
    uncachedInput: 0.75,
    cachedInput: 0.075,
    cacheWriteInput: 0.75,
    output: 4.5
  });
  assert.equal(result.telemetry.pricing.estimatedCostUsd, 0.8025);
});

test("unknown model telemetry retains tokens and never reports a zero estimated cost", async () => {
  const tokenUsage = {
    inputTokens: 10,
    uncachedInputTokens: 10,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 2,
    reasoningOutputTokens: 0,
    totalTokens: 12
  };
  const result = await callStructured({
    adapter: {
      provider: "openai",
      call: async () => ({ output: {}, tokenUsage })
    },
    provider: "openai",
    model: "gpt-future",
    profiles: {
      "openai/gpt-future": {
        id: "openai/gpt-future",
        provider: "openai",
        model: "gpt-future",
        pagesPerChunk: 1,
        overlapPages: 0,
        maxOutputTokens: 100,
        maxSplitDepth: 0
      }
    },
    system: "Extract.",
    userBlocks: [{ type: "text", text: "Invoice." }],
    tool: { name: "extract", input_schema: { type: "object" } }
  });

  assert.deepEqual(result.telemetry.tokenUsage, tokenUsage);
  assert.equal(result.telemetry.pricing.available, false);
  assert.equal(result.telemetry.pricing.estimatedCostUsd, null);
  assert.equal(result.telemetry.pricing.unavailableReason, "unknown_model");
});

test("structured request failures carry normalized attempt telemetry", async () => {
  const adapterError = new Error("busy");
  adapterError.status = 503;
  adapterError.requestTelemetry = {
    elapsedMs: 25,
    providerRequestId: "req_failed",
    retryCount: 2,
    attempts: [{
      attempt: 3,
      startedAt: "2026-07-17T00:00:00.000Z",
      endedAt: "2026-07-17T00:00:00.025Z",
      elapsedMs: 25,
      outcome: "retryable_error",
      statusCode: 503,
      providerRequestId: "req_failed",
      errorType: "overloaded_error",
      retryDelayMs: null
    }]
  };

  await assert.rejects(
    () => callStructured({
      adapter: { provider: "anthropic", call: async () => { throw adapterError; } },
      provider: "anthropic",
      model: "claude-opus-4-8",
      system: "Extract.",
      userBlocks: [],
      tool: { name: "extract", input_schema: { type: "object" } }
    }),
    (error) => error.telemetry.provider === "anthropic"
      && error.telemetry.model === "claude-opus-4-8"
      && error.telemetry.providerRequestId === "req_failed"
      && error.telemetry.retryCount === 2
  );
});
