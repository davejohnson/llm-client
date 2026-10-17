const { resolveModelProfile } = require("./modelProfiles");
const { buildTelemetry } = require("./structuredCall");
const { normalizeSystem } = require("./systemPrompt");

const TOOL_CHOICE_TYPES = new Set(["auto", "none", "required"]);
const ASSISTANT_PHASES = new Set(["commentary", "final_answer"]);

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function normalizeToolChoice(toolChoice, tools, hasBuiltInTools = false) {
  const choice = toolChoice === undefined
    ? (tools.length || hasBuiltInTools ? "auto" : "none")
    : toolChoice;

  if (typeof choice === "string") {
    if (!TOOL_CHOICE_TYPES.has(choice)) {
      throw new Error("toolChoice must be auto, none, required, or a named tool choice.");
    }
    if (!tools.length && !hasBuiltInTools && choice !== "none") throw new Error(`toolChoice ${choice} requires at least one tool.`);
    return { type: choice };
  }

  if (choice && typeof choice === "object" && !Array.isArray(choice) && TOOL_CHOICE_TYPES.has(choice.type)) {
    if (!tools.length && !hasBuiltInTools && choice.type !== "none") throw new Error(`toolChoice ${choice.type} requires at least one tool.`);
    return { type: choice.type };
  }
  if (!choice || typeof choice !== "object" || Array.isArray(choice) || choice.type !== "tool") {
    throw new Error("A named toolChoice must have type tool and a tool name.");
  }
  const name = nonEmptyString(choice.name, "toolChoice.name");
  if (!tools.some((tool) => tool.name === name)) throw new Error(`toolChoice references unknown tool "${name}".`);
  return { type: "tool", name };
}

function normalizeWebSearch(webSearch) {
  if (webSearch === undefined || webSearch === null || webSearch === false) return null;
  if (webSearch === true) return {};
  if (!webSearch || typeof webSearch !== "object" || Array.isArray(webSearch)) {
    throw new Error("webSearch must be a boolean or an options object.");
  }
  const { searchContextSize } = webSearch;
  if (searchContextSize !== undefined && !["low", "medium", "high"].includes(searchContextSize)) {
    throw new Error("webSearch.searchContextSize must be low, medium, or high.");
  }
  return searchContextSize === undefined ? {} : { searchContextSize };
}

function normalizeChatTools(tools = []) {
  if (!Array.isArray(tools)) throw new Error("tools must be an array.");
  const names = new Set();
  return tools.map((tool, index) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      throw new Error(`tools[${index}] must be an object.`);
    }
    const name = nonEmptyString(tool.name, `tools[${index}].name`);
    if (names.has(name)) throw new Error(`Duplicate chat tool name "${name}".`);
    names.add(name);
    if (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
      throw new Error(`tools[${index}].inputSchema must be a JSON schema object.`);
    }
    if (tool.strict !== undefined && typeof tool.strict !== "boolean") {
      throw new Error(`tools[${index}].strict must be a boolean.`);
    }
    return {
      name,
      ...(tool.description === undefined ? {} : { description: String(tool.description) }),
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      inputSchema: tool.inputSchema
    };
  });
}

function normalizeChatBlock(block, role, messageIndex, blockIndex) {
  const label = `messages[${messageIndex}].content[${blockIndex}]`;
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw new Error(`${label} must be an object.`);
  }

  if (block.type === "text") {
    if (typeof block.text !== "string") throw new Error(`${label}.text must be a string.`);
    if (block.phase !== undefined) {
      if (role !== "assistant") throw new Error(`${label}.phase can only appear in an assistant message.`);
      if (!ASSISTANT_PHASES.has(block.phase)) {
        throw new Error(`${label}.phase must be commentary or final_answer.`);
      }
    }
    return {
      type: "text",
      text: block.text,
      ...(block.phase === undefined ? {} : { phase: block.phase })
    };
  }
  if (block.type === "reasoning") {
    if (role !== "assistant") throw new Error(`${label} can only appear in an assistant message.`);
    const provider = nonEmptyString(block.provider, `${label}.provider`);
    if (!block.data || typeof block.data !== "object" || Array.isArray(block.data)) {
      throw new Error(`${label}.data must be an opaque provider reasoning block.`);
    }
    return { type: "reasoning", provider, data: block.data };
  }
  if (block.type === "document" || block.type === "image") {
    if (role !== "user") throw new Error(`${label} can only appear in a user message.`);
    return { ...block };
  }
  if (block.type === "tool_call") {
    if (role !== "assistant") throw new Error(`${label} can only appear in an assistant message.`);
    const id = nonEmptyString(block.id, `${label}.id`);
    const name = nonEmptyString(block.name, `${label}.name`);
    if (!block.input || typeof block.input !== "object" || Array.isArray(block.input)) {
      throw new Error(`${label}.input must be an object.`);
    }
    return { type: "tool_call", id, name, input: block.input };
  }
  if (block.type === "tool_result") {
    if (role !== "user") throw new Error(`${label} can only appear in a user message.`);
    const toolCallId = nonEmptyString(block.toolCallId, `${label}.toolCallId`);
    if (block.output === undefined) throw new Error(`${label}.output is required.`);
    if (block.isError !== undefined && typeof block.isError !== "boolean") {
      throw new Error(`${label}.isError must be a boolean.`);
    }
    return {
      type: "tool_result",
      toolCallId,
      output: block.output,
      ...(block.isError === undefined ? {} : { isError: block.isError })
    };
  }
  throw new Error(`${label} has unsupported type "${block.type || "unknown"}".`);
}

function normalizeChatMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new Error("messages must be a non-empty array.");
  return messages.map((message, messageIndex) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new Error(`messages[${messageIndex}] must be an object.`);
    }
    if (!["user", "assistant", "system"].includes(message.role)) {
      throw new Error(`messages[${messageIndex}].role must be user, assistant, or system.`);
    }
    const isSystem = message.role === "system";
    if (message.outputConfig !== undefined) {
      if (!isSystem || !message.outputConfig || typeof message.outputConfig !== "object" || Array.isArray(message.outputConfig)) {
        throw new Error(`messages[${messageIndex}].outputConfig is only supported on system messages.`);
      }
      if (!Object.hasOwn(message.outputConfig, "effort") || !["low", "medium", "high", "xhigh", "max"].includes(message.outputConfig.effort)) {
        throw new Error(`messages[${messageIndex}].outputConfig.effort must be low, medium, high, xhigh, or max.`);
      }
    }
    if (message.clearAt !== undefined) {
      if (!isSystem || !["next_user_message", "never"].includes(message.clearAt)) {
        throw new Error(`messages[${messageIndex}].clearAt is only supported on system messages and must be next_user_message or never.`);
      }
    }
    const content = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
    const allowsEmptyContent = isSystem && message.outputConfig !== undefined;
    if (!Array.isArray(content) || (!content.length && !allowsEmptyContent)) {
      throw new Error(`messages[${messageIndex}].content must be a non-empty string or array.`);
    }
    return {
      role: message.role,
      content: content.map((block, blockIndex) => (
        normalizeChatBlock(block, message.role, messageIndex, blockIndex)
      )),
      ...(message.outputConfig === undefined ? {} : {
        outputConfig: { effort: message.outputConfig.effort }
      }),
      ...(message.clearAt === undefined ? {} : { clearAt: message.clearAt })
    };
  });
}

async function callChatTurn({
  adapter,
  provider,
  model,
  profileId,
  profiles,
  system,
  messages,
  tools = [],
  toolChoice,
  parallelToolCalls = true,
  maxOutputTokens,
  promptCacheKey,
  webSearch
}) {
  if (!adapter || typeof adapter.turn !== "function") throw new Error("A provider adapter with turn() is required.");
  if (adapter.provider !== provider) throw new Error(`Adapter provider ${adapter.provider || "unknown"} does not match ${provider}.`);
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new Error("maxOutputTokens must be a positive integer.");
  }
  if (typeof parallelToolCalls !== "boolean") throw new Error("parallelToolCalls must be a boolean.");
  if (promptCacheKey !== undefined && (typeof promptCacheKey !== "string" || !promptCacheKey.trim())) {
    throw new Error("promptCacheKey must be a non-empty string.");
  }

  const normalizedMessages = normalizeChatMessages(messages);
  const normalizedTools = normalizeChatTools(tools);
  const normalizedWebSearch = normalizeWebSearch(webSearch);
  const normalizedToolChoice = normalizeToolChoice(toolChoice, normalizedTools, Boolean(normalizedWebSearch));
  const profile = resolveModelProfile({ provider, model, profileId, profiles });
  const modelMaxOutputTokens = profile.modelMaxOutputTokens || profile.maxOutputTokens;
  if (maxOutputTokens > modelMaxOutputTokens) {
    throw new Error(`maxOutputTokens cannot exceed the reviewed model limit of ${modelMaxOutputTokens}.`);
  }

  const startedAtMs = Date.now();
  try {
    const result = await adapter.turn({
      model,
      maxOutputTokens,
      system: normalizeSystem(system),
      messages: normalizedMessages,
      tools: normalizedTools,
      toolChoice: normalizedToolChoice,
      parallelToolCalls,
      effort: profile.effort,
      thinking: profile.thinking,
      pdfDetail: profile.pdfDetail,
      reasoningEffort: profile.reasoningEffort,
      promptCacheKey,
      webSearch: normalizedWebSearch
    });
    const endedAtMs = Date.now();
    const telemetry = buildTelemetry({
      provider,
      model,
      profile,
      tokenUsage: result.tokenUsage,
      requestMetadata: result.requestTelemetry,
      pricingContext: adapter.pricingContext,
      startedAtMs,
      endedAtMs,
      outcome: "success"
    });
    return { ...result, profile, telemetry };
  } catch (error) {
    const endedAtMs = Date.now();
    error.telemetry = buildTelemetry({
      provider,
      model,
      profile,
      tokenUsage: null,
      requestMetadata: error.requestTelemetry,
      pricingContext: adapter.pricingContext,
      startedAtMs,
      endedAtMs,
      outcome: "error",
      error
    });
    throw error;
  }
}

async function callText(options) {
  const { prompt, messages, ...turnOptions } = options;
  if (prompt !== undefined && messages !== undefined) {
    throw new Error("callText accepts either prompt or messages, not both.");
  }
  if (prompt === undefined && messages === undefined) {
    throw new Error("callText requires prompt or messages.");
  }
  const result = await callChatTurn({
    ...turnOptions,
    messages: messages || [{ role: "user", content: String(prompt) }],
    tools: [],
    parallelToolCalls: false
  });
  const text = result.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return { ...result, text };
}

async function* streamChatTurn({
  adapter,
  provider,
  model,
  profileId,
  profiles,
  system,
  messages,
  tools = [],
  toolChoice,
  parallelToolCalls = true,
  maxOutputTokens,
  promptCacheKey,
  webSearch
}) {
  if (!adapter || typeof adapter.streamTurn !== "function") {
    throw new Error("A provider adapter with streamTurn() is required.");
  }
  if (adapter.provider !== provider) throw new Error(`Adapter provider ${adapter.provider || "unknown"} does not match ${provider}.`);
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new Error("maxOutputTokens must be a positive integer.");
  }
  if (typeof parallelToolCalls !== "boolean") throw new Error("parallelToolCalls must be a boolean.");
  if (promptCacheKey !== undefined && (typeof promptCacheKey !== "string" || !promptCacheKey.trim())) {
    throw new Error("promptCacheKey must be a non-empty string.");
  }

  const normalizedMessages = normalizeChatMessages(messages);
  const normalizedTools = normalizeChatTools(tools);
  const normalizedWebSearch = normalizeWebSearch(webSearch);
  const normalizedToolChoice = normalizeToolChoice(toolChoice, normalizedTools, Boolean(normalizedWebSearch));
  const profile = resolveModelProfile({ provider, model, profileId, profiles });
  const modelMaxOutputTokens = profile.modelMaxOutputTokens || profile.maxOutputTokens;
  if (maxOutputTokens > modelMaxOutputTokens) {
    throw new Error(`maxOutputTokens cannot exceed the reviewed model limit of ${modelMaxOutputTokens}.`);
  }

  const startedAtMs = Date.now();
  try {
    let completed = false;
    for await (const event of adapter.streamTurn({
      model,
      maxOutputTokens,
      system: normalizeSystem(system),
      messages: normalizedMessages,
      tools: normalizedTools,
      toolChoice: normalizedToolChoice,
      parallelToolCalls,
      effort: profile.effort,
      thinking: profile.thinking,
      pdfDetail: profile.pdfDetail,
      reasoningEffort: profile.reasoningEffort,
      promptCacheKey,
      webSearch: normalizedWebSearch
    })) {
      if (event.type !== "done") {
        yield event;
        continue;
      }
      completed = true;
      const endedAtMs = Date.now();
      const result = event.result;
      const telemetry = buildTelemetry({
        provider,
        model,
        profile,
        tokenUsage: result.tokenUsage,
        requestMetadata: result.requestTelemetry,
        pricingContext: adapter.pricingContext,
        startedAtMs,
        endedAtMs,
        outcome: "success"
      });
      yield { type: "done", result: { ...result, profile, telemetry } };
    }
    if (!completed) throw new Error("Provider stream ended without a done event.");
  } catch (error) {
    if (!error.telemetry) {
      const endedAtMs = Date.now();
      error.telemetry = buildTelemetry({
        provider,
        model,
        profile,
        tokenUsage: null,
        requestMetadata: error.requestTelemetry,
        pricingContext: adapter.pricingContext,
        startedAtMs,
        endedAtMs,
        outcome: "error",
        error
      });
    }
    throw error;
  }
}

module.exports = {
  callChatTurn,
  callText,
  normalizeChatMessages,
  normalizeSystem,
  normalizeChatTools,
  normalizeToolChoice,
  normalizeWebSearch,
  streamChatTurn
};
