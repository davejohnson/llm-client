const test = require("node:test");
const assert = require("node:assert/strict");
const Anthropic = require("@anthropic-ai/sdk");
const { createAnthropicAdapter } = require("..");

const message = {
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [{ type: "text", text: "Finished." }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 2 }
};

function providerResponse(stream) {
  if (!stream) return Response.json(message);
  const events = [
    { type: "message_start", message: { ...message, content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Finished." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: "message_stop" }
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" }
  });
}

// Anthropic's ToolChoiceNone has only `type`; auto, any, and tool support
// disable_parallel_tool_use. Assert the JSON serialized by the real SDK,
// rather than substituting a messages.create/stream mock for this boundary.
// https://github.com/anthropics/anthropic-sdk-typescript/blob/v0.123.0/src/resources/messages/messages.ts
const choices = [
  { label: "none string", toolChoice: "none", expected: { type: "none" } },
  { label: "none object", toolChoice: { type: "none" }, expected: { type: "none" } },
  { label: "auto", toolChoice: "auto", expected: { type: "auto" } },
  { label: "required", toolChoice: "required", expected: { type: "any" } },
  { label: "named", toolChoice: { type: "tool", name: "lookup" }, expected: { type: "tool", name: "lookup" } }
];

for (const method of ["turn", "streamTurn"]) {
  for (const { label, toolChoice, expected } of choices) {
    for (const parallelToolCalls of [false, true]) {
      test(`Anthropic ${method} serializes ${label} with parallelToolCalls=${parallelToolCalls}`, async () => {
        const requests = [];
        const client = new Anthropic({
          apiKey: "test-key",
          maxRetries: 0,
          fetch: async (url, options) => {
            assert.equal(new URL(url).pathname, "/v1/messages");
            const body = JSON.parse(options.body);
            requests.push(body);
            return providerResponse(body.stream);
          }
        });
        const adapter = createAnthropicAdapter({ client, maxRetries: 0 });
        const request = {
          model: "claude-sonnet-5",
          maxOutputTokens: 100,
          system: "Answer concisely.",
          messages: [{ role: "user", content: "Summarize the result." }],
          tools: [{ name: "lookup", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
          toolChoice,
          parallelToolCalls
        };
        let result;
        if (method === "turn") {
          result = await adapter.turn(request);
        } else {
          for await (const event of adapter.streamTurn(request)) {
            if (event.type === "done") result = event.result;
          }
        }
        assert.equal(requests.length, 1);
        assert.equal(requests[0].tools[0].name, "lookup");
        assert.deepEqual(requests[0].tool_choice, {
          ...expected,
          ...(expected.type !== "none" && !parallelToolCalls ? { disable_parallel_tool_use: true } : {})
        });
        assert.deepEqual(result.message.content, [{ type: "text", text: "Finished." }]);
      });
    }
  }
}
