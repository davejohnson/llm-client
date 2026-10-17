const assert = require("node:assert/strict");
const test = require("node:test");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const {
  callChatTurn,
  callStructured,
  createAnthropicAdapter,
  createMetaAdapter,
  createOpenAIAdapter,
  pdfChunksForBytes
} = require("..");

const invoiceTool = {
  name: "return_invoice",
  description: "Return the extracted invoice fields.",
  input_schema: {
    type: "object",
    properties: {
      vendor: { type: "string" },
      total: { type: "number" },
      currency: { type: "string" }
    },
    required: ["vendor", "total", "currency"],
    additionalProperties: false
  }
};

function requireApiKey(name) {
  assert.ok(
    process.env[name],
    `${name} is required for live provider acceptance tests.`
  );
  return process.env[name];
}

async function makeInvoicePdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText("INVOICE", { x: 72, y: 700, size: 24, font, color: rgb(0, 0, 0) });
  page.drawText("Vendor: Acme Corp", { x: 72, y: 650, size: 14, font });
  page.drawText("Total: 42.50 CAD", { x: 72, y: 620, size: 14, font });
  return Buffer.from(await pdf.save());
}

async function invoiceBlock() {
  const bytes = await makeInvoicePdf();
  const { chunks } = await pdfChunksForBytes(bytes, {
    sourceFile: "live-test-invoice.pdf",
    pagesPerChunk: 1,
    overlapPages: 0
  });
  return chunks[0];
}

async function extractInvoice({ adapter, provider, model, system, block }) {
  return callStructured({
    adapter,
    provider,
    model,
    system: system || "Extract the invoice accurately. Use the return_invoice tool to return the result.",
    userBlocks: [
      block || await invoiceBlock(),
      { type: "text", text: "Extract the vendor, numeric total, and three-letter currency code." }
    ],
    tool: invoiceTool,
    promptCacheKey: "llm-client-live-invoice-v1"
  });
}

function assertInvoice(result) {
  assert.equal(result.toolError, null);
  assert.match(result.output.vendor, /acme/i);
  assert.ok(Math.abs(result.output.total - 42.5) < 0.001);
  assert.equal(result.output.currency.toUpperCase(), "CAD");
  assert.ok(result.tokenUsage.inputTokens > 0);
  assert.ok(result.tokenUsage.outputTokens > 0);
}

test("OpenAI accepts a native PDF and returns strict structured output", {
  skip: process.env.LIVE_OPENAI_PDF !== "1"
}, async () => {
  const adapter = createOpenAIAdapter({ apiKey: requireApiKey("OPENAI_API_KEY") });
  assertInvoice(await extractInvoice({
    adapter,
    provider: "openai",
    model: "gpt-5.4-mini"
  }));
});

for (const [model, flag] of [["gpt-6-sol", "LIVE_OPENAI_GPT6_SOL_PDF"], ["gpt-6-luna", "LIVE_OPENAI_GPT6_LUNA_PDF"]]) {
  test(`${model} accepts a native PDF and returns strict structured output`, {
    skip: process.env[flag] !== "1"
  }, async () => {
    const adapter = createOpenAIAdapter({ apiKey: requireApiKey("OPENAI_API_KEY") });
    assertInvoice(await extractInvoice({ adapter, provider: "openai", model }));
  });
}

test("Muse Spark 1.3 accepts a native PDF and returns strict structured output", {
  skip: process.env.LIVE_META_PDF !== "1"
}, async () => {
  const adapter = createMetaAdapter({ apiKey: requireApiKey("MODEL_API_KEY") });
  assertInvoice(await extractInvoice({
    adapter,
    provider: "meta",
    model: "muse-spark-1.3",
    system: "Extract the invoice accurately and return the requested schema."
  }));
});

test("Sonnet 5 accepts a native PDF and returns the forced strict tool call", {
  skip: process.env.LIVE_ANTHROPIC_PDF !== "1"
}, async () => {
  const adapter = createAnthropicAdapter({ apiKey: requireApiKey("ANTHROPIC_API_KEY") });
  const result = await extractInvoice({
    adapter,
    provider: "anthropic",
    model: "claude-sonnet-5"
  });
  assertInvoice(result);
  assert.ok(result.responseContent.some((part) => (
    part.type === "tool_use" && part.name === invoiceTool.name
  )));
});

test("Fable 5.1 accepts a native PDF and returns the requested strict tool call", {
  skip: process.env.LIVE_ANTHROPIC_51_PDF !== "1"
}, async () => {
  const adapter = createAnthropicAdapter({ apiKey: requireApiKey("ANTHROPIC_API_KEY") });
  const result = await extractInvoice({
    adapter,
    provider: "anthropic",
    model: "claude-fable-5-1"
  });
  assertInvoice(result);
  assert.ok(result.responseContent.some((part) => (
    part.type === "tool_use" && part.name === invoiceTool.name
  )));
});

test("Opus 5.5 accepts a native PDF and returns the requested strict tool call", {
  skip: process.env.LIVE_ANTHROPIC_OPUS_55_PDF !== "1"
}, async () => {
  const adapter = createAnthropicAdapter({ apiKey: requireApiKey("ANTHROPIC_API_KEY") });
  const result = await extractInvoice({ adapter, provider: "anthropic", model: "claude-opus-5-5" });
  assertInvoice(result);
  assert.ok(result.responseContent.some((part) => (
    part.type === "tool_use" && part.name === invoiceTool.name
  )));
});

test("Sonnet 5.5 accepts a native PDF and returns the requested strict tool call", {
  skip: process.env.LIVE_ANTHROPIC_SONNET_55_PDF !== "1"
}, async () => {
  const adapter = createAnthropicAdapter({ apiKey: requireApiKey("ANTHROPIC_API_KEY") });
  const result = await extractInvoice({ adapter, provider: "anthropic", model: "claude-sonnet-5-5" });
  assertInvoice(result);
  assert.ok(result.responseContent.some((part) => (
    part.type === "tool_use" && part.name === invoiceTool.name
  )));
});

test("OpenAI completes a normalized tool-call conversation", {
  skip: process.env.LIVE_OPENAI_CHAT !== "1"
}, async () => {
  const adapter = createOpenAIAdapter({ apiKey: requireApiKey("OPENAI_API_KEY") });
  const tools = [{
    name: "get_work_order",
    description: "Get one work order by its identifier.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false
    }
  }];
  const messages = [{
    role: "user",
    content: [{ type: "text", text: "Use the tool to check work order WO-42." }]
  }];
  const called = await callChatTurn({
    adapter,
    provider: "openai",
    model: "gpt-5.4-mini",
    system: "Use the work-order tool when asked, then summarize its result.",
    messages,
    tools,
    toolChoice: { type: "tool", name: "get_work_order" },
    parallelToolCalls: false,
    maxOutputTokens: 1024,
    promptCacheKey: "llm-client-live-chat-v1"
  });
  assert.equal(called.toolError, null);
  assert.equal(called.stopReason, "tool_call");
  const toolCall = called.message.content.find((block) => block.type === "tool_call");
  assert.ok(toolCall);
  assert.equal(toolCall.name, "get_work_order");
  assert.equal(toolCall.input.id, "WO-42");

  messages.push(called.message, {
    role: "user",
    content: [{
      type: "tool_result",
      toolCallId: toolCall.id,
      output: { id: "WO-42", status: "complete", summary: "Roof flashing repaired." }
    }]
  });
  const answered = await callChatTurn({
    adapter,
    provider: "openai",
    model: "gpt-5.4-mini",
    system: "Use the work-order tool when asked, then summarize its result.",
    messages,
    tools,
    toolChoice: "none",
    parallelToolCalls: false,
    maxOutputTokens: 1024,
    promptCacheKey: "llm-client-live-chat-v1"
  });
  assert.equal(answered.toolError, null);
  assert.equal(answered.stopReason, "end_turn");
  assert.match(
    answered.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"),
    /roof|flashing|complete/i
  );
});

test("OpenAI and Anthropic report a cache hit on a repeated stable prefix", {
  skip: process.env.LIVE_CACHE_DIAGNOSTICS !== "1"
}, async () => {
  const stableSystem = [
    "Extract the invoice accurately. Return only the required tool call.",
    "This deliberately long, stable prefix exercises provider prompt caching.",
    "stable-invoice-instruction ".repeat(6000)
  ].join("\n");
  const block = await invoiceBlock();
  const cases = [
    {
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: createOpenAIAdapter({ apiKey: requireApiKey("OPENAI_API_KEY") })
    },
    {
      provider: "anthropic",
      model: "claude-sonnet-5",
      adapter: createAnthropicAdapter({ apiKey: requireApiKey("ANTHROPIC_API_KEY") })
    }
  ];

  for (const providerCase of cases) {
    await extractInvoice({ ...providerCase, system: stableSystem, block });
    const repeated = await extractInvoice({ ...providerCase, system: stableSystem, block });
    assert.ok(
      repeated.tokenUsage.cachedInputTokens > 0,
      `${providerCase.provider} did not report cached input tokens: ${JSON.stringify(repeated.tokenUsage)}`
    );
  }
});
