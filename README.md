# llm-client

Provider-neutral Node.js client primitives for text generation, streaming
chat, tool-driven agent turns, and machine-consumed document extraction.

For text and chat, it normalizes messages, streaming events, tool calls, tool
results, usage, retries, and pricing telemetry without owning the application's
agent loop. For document extraction, it sends PDF bytes as native provider
document/file input and requests strict structured output. Every returned object
is validated against the caller's original JSON Schema before the application
receives it. It does not own persistence, queues, prompts, application tools, or
escalation.

Apps select a reviewed `provider/model` profile. Unknown models fail until an
explicit profile is supplied and tested.

## Install

```sh
npm install @bliggy/llm-client
```

Node.js 22 or newer is required. CI also exercises the current Node 24 LTS and
Node 26 release lines; package publishing runs on Node 24.

GPT-6 Sol and Luna are available through `createOpenAIAdapter()` with
`provider: "openai"` and `model: "gpt-6-sol"` or `"gpt-6-luna"`. Both profiles
use Responses, explicit `reasoningEffort: "none"`, a 12,000-token extraction
budget, and a 128,000-token output limit. Their 20-page chunks, two-page overlap,
and low PDF detail are inherited package defaults, not model quality measurements.

For these two models, omit `promptCacheRetention`: the adapter sends
`prompt_cache_options: { ttl: "30m" }` for extraction, chat, and streaming.
Legacy retention options fail locally. `promptCacheKey` remains supported.
Standard per-million-token rates are $2 input / $0.20 cache read / $2.50 cache
write / $10 output for Sol, and $0.10 / $0.01 / $0.125 / $0.50 for Luna.
Above 272,000 input tokens, telemetry applies 2× input/cache rates and 1.5×
output rates to the full request. See official OpenAI documentation for
[Sol](https://developers.openai.com/api/docs/models/gpt-6-sol),
[Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), and
[prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
reviewed September 22, 2026. Local transport tests cover the request contract;
live model compatibility and extraction quality require the opt-in checks below.

## Example

```js
const fs = require("node:fs/promises");
const {
  callStructured,
  createOpenAIAdapter,
  pdfChunksForBytes
} = require("@bliggy/llm-client");

const bytes = await fs.readFile("invoice.pdf");
const { chunks } = await pdfChunksForBytes(bytes, {
  sourceFile: "invoice.pdf",
  pagesPerChunk: 20,
  overlapPages: 2
});

const result = await callStructured({
  adapter: createOpenAIAdapter({ apiKey: process.env.OPENAI_API_KEY }),
  provider: "openai",
  model: "gpt-5.4-mini",
  promptCacheKey: "invoice-extraction-v1",
  system: "Extract the invoice. Return only the required function call.",
  maxOutputTokens: 4096,
  userBlocks: [
    chunks[0],
    { type: "text", text: "Return the vendor, total, and currency." }
  ],
  tool: {
    name: "return_invoice",
    description: "Return extracted invoice fields.",
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
  }
});

if (result.toolError) throw result.toolError;
console.log(result.output, result.telemetry);
```

`maxOutputTokens` is optional for structured calls. When omitted, the reviewed
profile budget is used. A smaller per-call budget can reduce latency and cost;
values above the reviewed model limit are rejected.

Use `createAnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY })` with
`provider: "anthropic"` and `model: "claude-fable-5-1"` for Claude Fable 5.1.
For Opus 5.5, use `model: "claude-opus-5-5"`. Its built-in profile uses medium
effort and adaptive thinking, with a 16,000-token extraction budget and a
128,000-token model output limit. The 30-page chunks and three-page overlap are
package defaults carried forward from Opus 5, not measured Opus 5.5 quality limits.
For Sonnet 5.5, use `model: "claude-sonnet-5-5"`. Its built-in profile uses high
effort and adaptive thinking, with a 12,000-token output budget and a
128,000-token model output limit. The 24-page chunks and three-page overlap are
package defaults carried forward from Sonnet 5, not measured quality limits.
Use `createMetaAdapter({ apiKey: process.env.MODEL_API_KEY })` with
`provider: "meta"` and `model: "muse-spark-1.3"` for Meta Muse Spark 1.3.

Provider-neutral document blocks carry `mediaType` and `dataBase64`. For
`text/plain`, the bytes must be base64-encoded UTF-8; the OpenAI and Meta
adapters decode them to `input_text`, while the Anthropic adapter decodes them
to a document text source. PDF and image blocks remain provider-native base64
inputs.

## Jev decisions

Use `callDecision` with TypeSafe's Jev to classify or score extracted text and
records. It accepts typed questions and returns their answers, probabilities,
and confidence values. Applications own the thresholds and actions.

```js
const { callDecision, createTypeSafeAdapter } = require("@bliggy/llm-client");

const result = await callDecision({
  adapter: createTypeSafeAdapter({ apiKey: process.env.TYPESAFE_API_KEY }),
  model: "jev-1.13.0",
  state: { vendor: "Acme", total: 42.50, currency: "CAD" },
  questions: {
    documentType: {
      type: "choice",
      instructions: "Classify this record.",
      criteria: { invoice: "A bill for goods or services", other: "Another record" }
    },
    completeness: {
      type: "score",
      instructions: "Rate how complete the invoice fields are.",
      criteria: ["No usable fields", "Some fields missing", "All fields present"]
    },
    needsReview: {
      type: "noul",
      instructions: "Does this record contain missing or inconsistent invoice data?"
    }
  }
});

console.log(result.answers, result.telemetry);
```

`state` and question `instructions` accept strings, JSON objects, or arrays.
Choice accepts up to 255 options; Score accepts 2–10 ordered levels and returns
a potentially fractional score. Noul returns a number from 0 to 1.
Preprocess PDFs and other binary inputs into text or records before calling Jev.
The decision interface has no chat, streaming, tools, or output-token budget.

The default model is pinned to `jev-1.13.0`. `jev-latest` and `jev-preview` are
explicit options in `BUILTIN_DECISION_PROFILES`; their resolved version is
returned in `result.model` and `telemetry.resolvedModel`. Decision profiles are
separate from chat/document profiles. Other model names fail locally through
`callDecision`; the low-level adapter's `decide` method accepts explicit models.

Requests use TypeSafe's direct `/v1/systemone` endpoint. Adapter options include
`baseUrl` (including `/v1`), `timeoutMs` (60 seconds per attempt), and `maxRetries`
(two by default). The API key defaults to `TYPESAFE_API_KEY`. Retryable HTTP and
network failures use backoff and honor `Retry-After`; authentication and invalid
successful responses are not retried. Answers are validated before return.
Results include raw `usage`, normalized `tokenUsage`, and `telemetry`; request
failures carry provider metadata and `error.telemetry`.

Pricing uses the resolved model: Jev 1.13 costs $0.042 per million input tokens
with free output tokens. Unrecognized resolved versions have an unavailable
cost estimate. See the official [API contract](https://docs.typesafe.ai/api) and
[model reference](https://docs.typesafe.ai/models), reviewed September 20, 2026.
Token context limits remain provider-enforced; this package has no Jev tokenizer.

The required test suite verifies documented wire shapes through a local HTTP
server and exercises validation, retries, and timeouts. Those checks do not
establish live service compatibility or decision accuracy. Run the opt-in live
check with `LIVE_TYPESAFE_DECISION=1 TYPESAFE_API_KEY=... npm run test:live`.

## Chat and tool turns

`callChatTurn` uses the same conversation contract for GPT, Claude, and Muse
Spark. The contract is intentionally not any provider's wire format:

- tools use `inputSchema`
- assistant calls use `{ type: "tool_call", id, name, input }`
- application results use
  `{ type: "tool_result", toolCallId, output, isError? }`
- provider reasoning uses
  `{ type: "reasoning", provider, data }`, where `data` is opaque
- each result contains a complete normalized assistant `message`

```js
const {
  callChatTurn,
  createOpenAIAdapter
} = require("@bliggy/llm-client");

const adapter = createOpenAIAdapter({
  apiKey: process.env.OPENAI_API_KEY
});
const tools = [{
  name: "find_work_orders",
  description: "Find work orders matching a short query.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      status: { type: "string" }
    },
    required: ["query"],
    additionalProperties: false
  }
}];
const messages = [{
  role: "user",
  content: [{ type: "text", text: "What happened with the roof repair?" }]
}];

for (let turn = 0; turn < 12; turn += 1) {
  const result = await callChatTurn({
    adapter,
    provider: "openai",
    model: "gpt-5.4-mini",
    system: "Answer property questions. Use tools when records are needed.",
    messages,
    tools,
    toolChoice: "auto",
    parallelToolCalls: false,
    maxOutputTokens: 2048,
    promptCacheKey: "property-chat-v1"
  });

  if (result.toolError) throw result.toolError;
  messages.push(result.message);

  const toolCall = result.message.content.find(
    (block) => block.type === "tool_call"
  );
  if (!toolCall) {
    console.log(
      result.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
    );
    break;
  }

  const output = await executeApplicationTool(toolCall.name, toolCall.input);
  messages.push({
    role: "user",
    content: [{
      type: "tool_result",
      toolCallId: toolCall.id,
      output
    }]
  });
}
```

Swap the adapter, provider, and model for Claude or Muse Spark; the messages,
tools, and loop stay unchanged. For Sonnet 5 chat, select
`profileId: "anthropic/claude-sonnet-5-chat"` to use medium effort with adaptive
thinking. `toolChoice` accepts `"auto"`, `"none"`, `"required"`, or
`{ type: "tool", name }`. Set `parallelToolCalls: false` when the application
executes one tool per turn.

Claude Opus 5.5, Claude Fable 5.1, and Claude Mythos 5.1 reject `"required"` and named tool
choices because their adaptive thinking is always on. Use `"auto"` with strict
tools and explicitly tell the model when to call each tool. The adapter rejects
unsupported choices locally instead of sending a request Anthropic will reject.

Opus 5.5 structured extraction uses automatic selection with a strict tool;
name the output tool in your prompt. A response without that tool is reported
through `result.toolError`. Preserve returned reasoning blocks unchanged and
keep the conversation append-only. Use `thinkingDisplay: "updates"` to receive
inter-tool progress via `progress_delta` events when streaming. The built-in
profile enables adaptive thinking; custom profiles must not disable thinking
or set a manual thinking budget on Opus 5.5.

Opus 5.5 pricing telemetry uses $4 input, $20 output, $0.20 cache read,
$5 five-minute cache write, and $8 one-hour cache write per million tokens.
These contracts and rates were checked against Anthropic's
[model reference](https://platform.claude.com/docs/en/models/opus-5-5/overview)
and [migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide)
on September 22, 2026. SDK transport regression tests cover request behavior;
they do not establish live compatibility or extraction quality.

Sonnet 5.5 also uses automatic selection with strict tools for extraction and
rejects required or named chat tool choices. Name the output tool in your prompt
and check `result.toolError`. Preserve reasoning blocks unchanged when continuing
the conversation. The built-in profile uses adaptive thinking; do not copy
Sonnet 5's disabled-thinking profile. The new `between_tools` thinking mode is
not exposed by profile validation yet.

Sonnet 5.5 pricing telemetry uses $2 input, $10 output, $0.20 cache read,
$2.50 five-minute cache write, and $4 one-hour cache write per million tokens.
The [model reference](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)
and [migration guide](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide)
were reviewed September 28, 2026. Regression tests exercise the real SDK with
synthetic HTTP responses, including retries; they do not establish live model
compatibility or extraction quality. Run the optional PDF smoke test with
`LIVE_ANTHROPIC_SONNET_55_PDF=1 ANTHROPIC_API_KEY=... npm run test:live`.

For Haiku 5.5, use `model: "claude-haiku-5-5"`. Its general text/chat profile
uses adaptive thinking, medium effort, a 16,000-token structured-call budget,
and a 128,000-token model output limit. Chat still requires an explicit
`maxOutputTokens`; document chunk geometry requires a custom profile.
Haiku 5.5 accepts required and named tool choices, which skip thinking before
the tool call. Automatic tool calls can return opaque thinking signatures;
preserve them unchanged and keep earlier history, tools, and system prompts
unchanged when replaying through the originating account.

Haiku 5.5 pricing per million tokens is $0.10 input, $0.50 output, $0.01
cache read, $0.125 five-minute cache write, and $0.20 one-hour cache write.
All five rates increase fivefold for requests above 100,000 input tokens.
These contracts were checked against the
[model reference](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
and [migration guide](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide)
on October 7, 2026. SDK transport tests cover retries and buffered/streaming
thinking replay with synthetic responses; live compatibility and quality
have not been measured.

Muse Spark 1.3 also supports only automatic function selection. Use `"auto"`
for agent tools. `"required"` and named choices are rejected locally;
`"none"` is implemented by omitting tools because Meta rejects an explicit
none choice. `callStructured` is unaffected because the Meta adapter uses
Responses JSON Schema output instead of pretending a forced function is
supported.

`maxOutputTokens` is required for chat turns. Chat answers usually need a much
smaller budget than document extraction, so the package does not silently reuse
the profile's 12,000- or 16,000-token extraction budget. It rejects values above
the reviewed model limit.

The application supplies the complete normalized message history on each turn.
Text and tool blocks remain portable between providers. Thinking-enabled
responses can also contain opaque `reasoning` blocks: persist them as part of
the assistant message and replay them unchanged to the same provider. In
particular, Anthropic requires its complete thinking and redacted-thinking
blocks when a tool result continues an assistant turn.

## Text and streaming chat

Use `callText` when no application tools are needed:

```js
const {
  callText,
  createAnthropicAdapter
} = require("@bliggy/llm-client");

const result = await callText({
  adapter: createAnthropicAdapter({
    apiKey: process.env.ANTHROPIC_API_KEY
  }),
  provider: "anthropic",
  model: "claude-haiku-4-5",
  system: "Answer concisely.",
  prompt: "Summarize today's inventory exceptions.",
  maxOutputTokens: 1024
});

console.log(result.text, result.telemetry);
```

`callText` also accepts normalized `messages` instead of `prompt`. It returns
the complete chat result plus a `text` convenience field containing all
assistant text blocks.

System prompts accept a string, provider-neutral text blocks, or an array of
strings. Empty text blocks are discarded before the provider adapter is called.

`streamChatTurn` accepts the same options as `callChatTurn` and emits
provider-neutral events:

```js
for await (const event of streamChatTurn(options)) {
  if (event.type === "text_delta") process.stdout.write(event.text);
  if (event.type === "progress_delta") showStatus(event.text);
  if (event.type === "tool_call_start") startTool(event.id, event.name);
  if (event.type === "tool_call_delta") appendToolInput(
    event.id,
    event.inputJsonDelta
  );
  if (event.type === "done") saveResult(event.result);
}
```

The final `done` result has the same normalized message, usage, profile, and
telemetry envelope as a non-streaming call. Provider adapters retry only before
the first streamed output is delivered, so a caller never receives duplicate
text, progress, or tool-input deltas.

## Claude 5.1 controls

Claude Fable 5.1 and the invitation-only Claude Mythos 5.1 support a one-million
token context window, 128,000 output tokens, and always-on adaptive thinking.
Both use high effort in the built-in profiles. Fable is the generally available
model; Mythos requires Project Glasswing access and both models require 30-day
data retention unless Anthropic expressly authorizes otherwise.

The adapter enables the required beta headers automatically when these optional
features are used:

```js
const adapter = createAnthropicAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY,
  thinkingDisplay: "updates",
  thinkingPrefixMismatchBehavior: "drop_block"
});

const messages = [
  { role: "user", content: "Plan the migration." },
  { role: "assistant", content: "Here is the plan." },
  // Change effort without invalidating the cached conversation prefix.
  { role: "system", content: [], outputConfig: { effort: "low" } },
  // Keep a one-turn reminder in the append-only history.
  {
    role: "system",
    content: "Summarize only on this turn.",
    clearAt: "next_user_message"
  },
  { role: "user", content: "Summarize it." }
];
```

`thinkingDisplay` accepts `"omitted"`, `"summarized"`, or the 5.1 beta value
`"updates"`. Streaming progress text is emitted as `progress_delta`; completed
results also expose it as `progressUpdates`. The original opaque reasoning block
remains in `message.content` and must still be replayed unchanged.

`thinkingPrefixMismatchBehavior` accepts `"error"` or `"drop_block"`. The
default is Anthropic's fail-closed error. With either explicit value, completed
results expose Anthropic's diagnostics as `inputTransformations`; use
`"drop_block"` only when continuing without invalidated reasoning is preferable
to failing. Keep `system`, tools, files, and prior turns stable and append new
messages to preserve 5.1 thinking blocks. Results also expose `stopDetails`,
including the classifier category when `stopReason` is `"refusal"`.

Anthropic's text watermarking is automatic and requires no adapter option. C2PA
credentials apply to supported generated files retrieved through Anthropic's
Files API, which remains outside this package's client-tool and document-input
scope.

## Meta Muse Spark 1.3

The reviewed `meta/muse-spark-1.3` profile uses Meta Model API's official
`https://api.meta.ai/v1` Responses endpoint. It has a 1,048,576-token context
window and a 131,072-token provider output limit. The application extraction
budget remains a conservative 12,000 tokens with 20-page PDF chunks and
two-page overlap. It requests `high` reasoning; Meta has announced that its new
maximum reasoning mode will arrive after additional safety testing, so the
built-in profile does not request it prematurely.

Muse Spark returns internal reasoning as an encrypted Responses item. The
adapter requests that encrypted item with `store: false`, exposes it as a
provider-neutral `{ type: "reasoning", provider: "meta", data }` block, and
replays the opaque `data` unchanged when it appears in later assistant history.
Do not inspect or modify the encrypted payload.

Grounded web search is available to text, chat, and streaming calls:

```js
const {
  callText,
  createMetaAdapter
} = require("@bliggy/llm-client");

const result = await callText({
  adapter: createMetaAdapter({
    apiKey: process.env.MODEL_API_KEY,
    promptCacheRetention: "24h"
  }),
  provider: "meta",
  model: "muse-spark-1.3",
  prompt: "Summarize today's relevant regulatory changes.",
  webSearch: { searchContextSize: "high" },
  maxOutputTokens: 4096,
  promptCacheKey: "regulatory-research-v1"
});

console.log(result.text);
console.log(result.citations);
console.log(result.webSearchCalls);
```

`webSearch` accepts `true` or an object whose `searchContextSize` is `"low"`,
`"medium"`, or `"high"`. Search is model-selected, so a valid result can have
no search calls or citations. When it does search, `citations` contains URL,
title, character offsets, and cited text; `webSearchCalls` preserves the raw
Responses search items. Streaming delivers text normally and includes complete
citations in the final `done` result.

Meta automatically caches identical prompt prefixes. `promptCacheKey` remains
the per-call routing hint. `createMetaAdapter({ promptCacheRetention: "24h" })`
requests longer retention; `"in_memory"` is also accepted.

Muse Spark accepts text, images, video, and PDF input and returns text. Images
use the neutral `image` block; PDFs and other supported files use `document`
with the correct `mediaType`, `filename`, and base64 data. Meta documents a
practical image ceiling of roughly 50 items per request, with PDF page images
counting toward that limit.

See Meta's [official Model API cookbook](https://github.com/meta-models/meta-model-cookbook),
[Muse Spark 1.3 announcement](https://research.meta.ai/blog/introducing-muse-spark-1-3),
and [Model API documentation](https://dev.meta.ai/docs).

## Reviewed profiles

- `anthropic/claude-haiku-5-5`: general text/chat profile with adaptive thinking,
  medium effort, a 16,000-token budget, and a 128,000-token output limit.
- `anthropic/claude-haiku-4-5`: general text/chat profile with a 16,000-token
  application output budget
- `anthropic/claude-sonnet-5`: medium effort, thinking disabled, 24 pages per chunk
- `anthropic/claude-sonnet-5-5`: high effort, adaptive thinking, 24 pages per
  chunk, 12,000-token output budget
- `anthropic/claude-sonnet-5-chat`: general Sonnet chat profile with medium
  effort and adaptive thinking
- `anthropic/claude-opus-4-8`: medium effort, thinking disabled, 30 pages per chunk
- `anthropic/claude-opus-4-8-dense`: the same Opus controls with 12-page
  chunks and three pages of overlap for dense maintenance binders
- `anthropic/claude-opus-5`: high effort with adaptive thinking, 30-page
  chunks, and three pages of overlap
- `anthropic/claude-fable-5-1`: high effort with always-on adaptive thinking,
  30-page chunks, three pages of overlap, and a 128,000-token model limit
- `anthropic/claude-mythos-5-1`: the same reviewed controls for approved Project
  Glasswing customers
- `meta/muse-spark-1.3`: high reasoning, 20-page chunks, two-page overlap,
  12,000-token application budget, and a 131,072-token model limit
- `openai/gpt-5.4`, `openai/gpt-5.4-mini`, and `openai/gpt-5.4-nano`
- `openai/gpt-5.5`
- `openai/gpt-5.6`, `openai/gpt-5.6-sol`, `openai/gpt-5.6-terra`, and
  `openai/gpt-5.6-luna`

Document profiles include page chunking controls. General text/chat profiles do
not need or expose document geometry. OpenAI document profiles use low-detail PDF input, no reasoning effort,
20-page chunks with two pages of overlap, and a 12,000-token application output
budget. The lower budget is intentional: it leaves headroom above observed
9,678-token extraction results without treating the models' 128,000-token
provider maximum as a useful target.

Use `openai/gpt-5.4-mini-chat`, `openai/gpt-6-sol-chat`, or
`openai/gpt-6-luna-chat` for explicit low-reasoning chat controls. These profiles
have a 12,000-token default output budget and no document geometry. The GPT-6
profiles are candidates for application evaluation; local transport tests do
not establish live model quality. OpenAI chat requests use `store: false` and
preserve opaque reasoning and assistant phase when replaying a tool turn.

The Opus 4.8 and Sonnet 5 document profiles disable thinking while forcing a
named structured-output tool. Opus 5 and the Claude 5.1 profiles use adaptive
thinking; the 5.1 models require it.

Built-in profiles expose `modelMaxOutputTokens` and validation rejects an
application `maxOutputTokens` value above that limit. Custom profiles may also
set this field.

Select an alternate profile independently from its underlying model:

```js
await callStructured({
  // ...adapter, prompt, document, and tool...
  provider: "anthropic",
  model: "claude-opus-4-8",
  profileId: "anthropic/claude-opus-4-8-dense"
});
```

## Strict schemas and incomplete output

Every `callStructured` result is validated against the original
`tool.input_schema`. Invalid provider tool input is returned with a
`ToolInputValidationError` in `result.toolError`; the error contains schema
paths and keywords, not the rejected provider values.

OpenAI strict function schemas require every declared object property to appear
in `required`. The adapter normalizes schemas recursively before sending them:
previously optional properties become required and nullable, nested objects and
arrays receive the same treatment, and `additionalProperties: false` is
preserved. Synthetic nulls for originally optional properties are removed before
the original schema is validated. `normalizeStrictSchema(schema)` is exported
for callers that need the same normalized representation elsewhere.

Anthropic strict tool use supports a narrower JSON Schema subset and enforces
schema-complexity limits. A reviewed document schema that cannot fit those
limits can use:

```js
createAnthropicAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY,
  strictDocumentTools: false
});
```

This only disables grammar compilation for `callStructured` document tools.
The explicit input schema remains in the request and the returned tool input is
still validated against that original schema. The named tool remains forced on
models that support forced tool use.

Claude Fable 5.1 and Claude Mythos 5.1 do not support forced tool use. For those
models, `callStructured` uses strict tool use by default with
`tool_choice: "auto"` and still returns a tool error when the requested tool was
not called. Include the exact tool name in the instruction, for example,
`Use the return_invoice tool to return the extracted invoice.`

Anthropic chat tools are strict by default while their complete set fits both
provider limits: at most 20 strict tools, 24 optional parameters, and 16
union-typed parameters across their schemas. When any limit is exceeded, the
adapter keeps every tool available but removes `strict` from all of them rather
than sending a request Anthropic will reject.

Applications with larger tool sets can select a consequential subset that fits
both limits for strict grammar while leaving the rest available as non-strict
tools. Add an explicit `strict` boolean to every provider-neutral chat tool in
that request; once any tool declares the preference, only tools with
`strict: true` compile strict. If the selected subset exceeds either limit, the
adapter removes strict from the whole set to preserve the provider-safe
failover:

```js
const tools = applicationTools.map((tool) => ({
  ...tool,
  strict: tool.requiresConfirmation
}));
```

OpenAI continues to compile every chat function strictly because it does not
share Anthropic's grammar caps. Disable Anthropic strict chat tools explicitly
when needed:

```js
createAnthropicAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY,
  strictChatTools: false
});
```

Non-strict tool schemas are still sent to the model, but their arguments are not
grammar-constrained; validate them before application execution.

When OpenAI reports `incomplete_details.reason: "max_output_tokens"`, or returns
a structurally truncated function argument string, the result has
`stopReason: "max_tokens"` and no JSON parsing error. Callers can split the
document chunk and retry.

## Cost controls

Claude system instructions receive an Anthropic ephemeral cache breakpoint
automatically. The default TTL is five minutes; set
`createAnthropicAdapter({ cacheTtl: "1h" })` for a one-hour cache.

OpenAI prompt caching is automatic for eligible prompts. Set a stable
`promptCacheKey` on `callStructured`, `callChatTurn`, `callText`, or
`streamChatTurn` to improve routing
consistency. For chat, keep the system prompt and tool definitions stable and
append new messages so the growing conversation remains a cacheable prefix.
OpenAI still bills the prior conversation tokens on every turn; prompt caching
discounts eligible repeated input rather than removing it from context.

Meta prompt caching is also automatic. Use the same `promptCacheKey` option;
set `promptCacheRetention: "24h"` on `createMetaAdapter()` when a longer cache
retention hint fits the workload.

OpenAI PDF input defaults to `detail: "low"`; use
`createOpenAIAdapter({ pdfDetail: "high" })` only when the document needs it.

Every result includes both the provider's raw `usage` and normalized
`tokenUsage`:

```js
{
  inputTokens,
  uncachedInputTokens,
  cachedInputTokens,
  cacheWriteInputTokens,
  cacheWrite5mInputTokens,
  cacheWrite1hInputTokens,
  outputTokens,
  reasoningOutputTokens,
  totalTokens
}
```

The TTL-specific cache-write fields are zero for OpenAI. For Anthropic, they
preserve the provider's five-minute and one-hour cache creation breakdown while
`cacheWriteInputTokens` remains their inclusive total.

Chunk creation and recursive splitting are sequential to reduce peak memory from
concurrent PDF copying and encoding. Split chunks preserve the overlap configured
when the original chunks were created.

For larger offline workloads, consider provider batch APIs or OpenAI's lower-cost
Flex processing tier where its slower, occasionally unavailable service fits the
job. For text-heavy PDFs, benchmark a text-extraction-first path against native
PDF input before changing the default: it can reduce token costs, but loses page
imagery and layout.

## Request telemetry and pricing

Every completed structured, text, chat, and streaming-chat result includes
normalized `telemetry`:

```js
{
  schemaVersion: 1,
  provider: "openai",
  model: "gpt-5.4-mini",
  profileId: "openai/gpt-5.4-mini",
  tokenUsage: { /* normalized categories shown above */ },
  elapsedMs: 1834,
  providerRequestId: "req_...",
  retryCount: 1,
  attempts: [{
    attempt: 1,
    startedAt: "2026-07-17T19:00:00.000Z",
    endedAt: "2026-07-17T19:00:00.400Z",
    elapsedMs: 400,
    outcome: "retryable_error",
    statusCode: 429,
    providerRequestId: "req_...",
    errorType: "rate_limit_error",
    retryDelayMs: 500
  }],
  pricing: {
    catalogVersion: "2026-07-17",
    available: true,
    currency: "USD",
    unit: "per_million_tokens",
    rates: {
      uncachedInput: 0.75,
      cachedInput: 0.075,
      cacheWriteInput: 0.75,
      output: 4.5
    },
    estimatedCostUsd: 0.0123
  }
}
```

`elapsedMs` measures the complete call. Each attempt separately
records its provider time and any backoff before the next attempt. Failed
provider calls attach the same normalized context to `error.telemetry`.

The immutable `PRICE_CATALOG` and `PRICE_CATALOG_VERSION` exports contain the
rates used by this release. Each result snapshots the catalog version, effective
rate schedule, applicable input/output/cache rates, rate modifiers, and cost by
token category. `snapshotModelPricing()` is exported for callers that need to
apply the same catalog to separately stored normalized usage.

Estimates use standard, synchronous, global API token rates. They do not include
batch or priority tiers, regional premiums, provider tools, storage, or other
non-token charges. The catalog includes supported-model long-context pricing
modifiers and current Claude model rates. When a custom profile names a model
absent from the catalog, tokens remain in telemetry but `pricing.available` is
`false` and `estimatedCostUsd` is `null`; unknown pricing is never reported as
`$0`. Claude Fable 5.1 and Mythos 5.1 use $10/$50 input/output rates and a
reduced $0.25 per-million-token cache-read rate. Claude Sonnet 5's $2/$10 launch
rates are permanent in this catalog. Muse Spark 1.3 uses Meta's standard
$1.25 input, $0.15 cached-input, and $4.25 output rates per million tokens.
Meta web-search charges are not included in token-only estimates.

## Errors and retries

Both adapters own their retries in this package and retry transient failures at
most twice by default. Opaque Anthropic SDK retries are disabled, including on
each request made through an injected SDK client. Both adapters record every
attempt, honor provider retry headers, and apply a ten-minute per-attempt
timeout. Set `maxRetries` or `timeoutMs` when creating an adapter to override
those defaults.

Provider failures also carry a normalized `providerError` envelope with
`provider`, `category`, and `requestId`. When supplied by the provider, the
envelope also includes safe machine-readable `code`, `type`, `statusCode`,
`scope`, and `retryable` fields. It never copies the provider's prose message.
Applications can inspect it with `providerErrorInfo(error)` or use
`isProviderCreditError(error)` without parsing an SDK-specific error shape.
Categories are only assigned when an adapter can identify the condition
reliably; otherwise `category` is `null`.

Applications that already hold bounded structured failure fields can use the
same classification without constructing an adapter or mutating an `Error`:

```js
const { normalizeProviderFailure } = require("@bliggy/llm-client");

const failure = normalizeProviderFailure({
  provider: "openai",
  code: receipt.errorCode,
  type: receipt.errorType,
  statusCode: receipt.statusCode,
  requestId: receipt.requestId
});
```

`normalizeProviderFailure()` is pure and returns a frozen `providerError`
envelope. It accepts only the documented provider, category, scope, identifier,
status, and retry fields; provider prose and unknown input keys never appear in
the result. Exact OpenAI code or type classification takes precedence over
supplied category, scope, or retryability values. HTTP status may preserve
retryability, but never assigns a failure category by itself.

OpenAI error categories are derived from exact `error.code` and `error.type`
values, not message text:

| Category | Meaning | Retryable |
| --- | --- | --- |
| `credit_exhausted` | Prepaid credits are depleted. | No |
| `spend_limit_exceeded` | A project or organization spend limit was reached. | No |
| `usage_limit_exceeded` | The provider-assigned organization usage limit was reached. | No |
| `quota_exhausted` | OpenAI reported `insufficient_quota` without a more specific code. | No |
| `rate_limited` | A temporary request, token, or ramp-rate limit was reached. | Yes |
| `context_limit_exceeded` | The request exceeded the model context window. | No |
| `output_limit_reached` | A Responses result ended with the exact `max_output_tokens` incomplete reason. | No |

The `scope` field distinguishes `project` and `organization` when OpenAI's code
does. An `insufficient_quota` type without a specific code cannot reliably tell
credits, spend limits, and usage limits apart, so the adapter intentionally uses
the generic `quota_exhausted` category. HTTP `429` alone is not treated as proof
of a temporary rate limit because OpenAI uses it for billing and quota errors
too, though the adapter preserves its existing bounded status-based retry when
no structured type or code is available. Known credit, spend, usage, and
context failures bypass retries; temporary rate limits keep the configured
bounded retry behavior.

## Tests

```sh
npm test
npm run test:coverage
```

Real-provider acceptance tests generate a PDF in memory and verify native PDF
input plus strict structured output. Each paid provider call is opt-in:

```sh
LIVE_OPENAI_PDF=1 OPENAI_API_KEY=... npm run test:live
LIVE_OPENAI_GPT6_SOL_PDF=1 OPENAI_API_KEY=... npm run test:live
LIVE_OPENAI_GPT6_LUNA_PDF=1 OPENAI_API_KEY=... npm run test:live
LIVE_META_PDF=1 MODEL_API_KEY=... npm run test:live
LIVE_ANTHROPIC_PDF=1 ANTHROPIC_API_KEY=... npm run test:live
LIVE_ANTHROPIC_51_PDF=1 ANTHROPIC_API_KEY=... npm run test:live
LIVE_ANTHROPIC_OPUS_55_PDF=1 ANTHROPIC_API_KEY=... npm run test:live
LIVE_OPENAI_CHAT=1 OPENAI_API_KEY=... npm run test:live
```

Set `LIVE_CACHE_DIAGNOSTICS=1` to additionally make repeated calls and require
OpenAI and Anthropic to report cached input tokens.

## Publishing

The package publishes to the public npm registry as `@bliggy/llm-client`.
The manually triggered `publish package` workflow runs the required checks and
publishes using the repository's `NPM_TOKEN` secret. Configure that secret with
an npm token authorized to publish this package before running the workflow.

## License

Copyright 2026 Dave Johnson.

Licensed under the [Apache License, Version 2.0](LICENSE).
