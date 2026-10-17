const Anthropic = require("@anthropic-ai/sdk");
const { normalizeAnthropicUsage } = require("./tokenUsage");
const { normalizeChatMessages, normalizeChatTools, normalizeToolChoice } = require("./chatTurn");
const { mediaTypeForDocument, textForDocument } = require("./documentContent");
const { attachProviderError } = require("./providerErrors");
const {
  attachRequestTelemetry,
  attemptRecord,
  providerRequestId,
  requestTelemetry,
  retryDelay,
  shouldRetryError
} = require("./requestTelemetry");

const ANTHROPIC_STRICT_TOOL_LIMIT = 20;
const ANTHROPIC_STRICT_OPTIONAL_PARAMETER_LIMIT = 24;
const ANTHROPIC_STRICT_UNION_PARAMETER_LIMIT = 16;
const AUTOMATIC_TOOL_CHOICE_MODELS = new Set(["claude-fable-5-1", "claude-mythos-5-1", "claude-opus-5-5", "claude-sonnet-5-5"]);
const THINKING_DISPLAY_UPDATES_BETA = "thinking-display-updates-2026-08-18";
const THINKING_BINDING_CONTROLS_BETA = "thinking-binding-controls-2026-08-01";
const MID_CONVERSATION_EFFORT_BETA = "mid-conversation-output-config-2026-07-01";
const TURN_SCOPED_SYSTEM_BETA = "mid-conversation-system-clear-at-2026-08-21";

function anthropicErrorCategory(error) {
  const messages = [
    error?.message,
    error?.error?.message,
    error?.error?.error?.message
  ].filter(Boolean);
  return messages.some((message) => String(message).toLowerCase().includes("credit balance is too low"))
    ? "credit_exhausted"
    : null;
}

function attachAnthropicError(error, telemetry) {
  return attachProviderError(attachRequestTelemetry(error, telemetry), {
    provider: "anthropic",
    category: anthropicErrorCategory(error),
    requestId: providerRequestId(error) || telemetry.providerRequestId
  });
}

function validateCacheTtl(cacheTtl) {
  if (!["5m", "1h"].includes(cacheTtl)) throw new Error("cacheTtl must be 5m or 1h.");
  return cacheTtl;
}

function asAnthropicContent(block) {
  if (block.source) return block;
  if (block.type === "text") return { type: "text", text: block.text, ...(block.cache_control ? { cache_control: block.cache_control } : {}) };
  if (block.type === "image") {
    return {
      type: "image",
      source: { type: "base64", media_type: block.mediaType, data: block.dataBase64 },
      ...(block.cache_control ? { cache_control: block.cache_control } : {})
    };
  }
  if (block.type === "document") {
    const text = textForDocument(block);
    if (text !== null) {
      return {
        type: "document",
        source: { type: "text", media_type: mediaTypeForDocument(block), data: text },
        ...(block.cache_control ? { cache_control: block.cache_control } : {})
      };
    }
    return {
      type: "document",
      source: { type: "base64", media_type: block.mediaType, data: block.dataBase64 },
      ...(block.cache_control ? { cache_control: block.cache_control } : {})
    };
  }
  throw new Error(`Unsupported Anthropic document block type: ${block.type}.`);
}

function asAnthropicSystem(system, cacheTtl) {
  const blocks = Array.isArray(system)
    ? system.map((block) => ({ ...block }))
    : [{ type: "text", text: String(system || "") }];
  if (!blocks.length || blocks.some((block) => block.cache_control)) return blocks;
  const lastTextIndex = blocks.findLastIndex((block) => block.type === "text");
  if (lastTextIndex >= 0) {
    blocks[lastTextIndex] = {
      ...blocks[lastTextIndex],
      cache_control: { type: "ephemeral", ttl: cacheTtl }
    };
  }
  return blocks;
}

function stringifyToolOutput(output) {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function requiresAutomaticToolChoice(model) {
  return AUTOMATIC_TOOL_CHOICE_MODELS.has(model);
}

function asAnthropicChatContent(block) {
  if (block.type === "reasoning") {
    if (block.provider !== "anthropic") {
      throw new Error(`Cannot replay ${block.provider} reasoning through the Anthropic adapter.`);
    }
    if (!["thinking", "redacted_thinking"].includes(block.data?.type)) {
      throw new Error(`Unsupported Anthropic reasoning block type: ${block.data?.type || "unknown"}.`);
    }
    return block.data;
  }
  if (block.type === "tool_call") {
    return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  }
  if (block.type === "tool_result") {
    return {
      type: "tool_result",
      tool_use_id: block.toolCallId,
      content: stringifyToolOutput(block.output),
      ...(block.isError === undefined ? {} : { is_error: block.isError })
    };
  }
  return asAnthropicContent(block);
}

function asAnthropicToolChoice(toolChoice, parallelToolCalls, model) {
  const disableParallel = parallelToolCalls ? {} : { disable_parallel_tool_use: true };
  if (requiresAutomaticToolChoice(model) && ["required", "tool"].includes(toolChoice.type)) {
    throw new Error(`${model} does not support required or named toolChoice; use auto with strict tools.`);
  }
  if (toolChoice.type === "tool") return { type: "tool", name: toolChoice.name, ...disableParallel };
  if (toolChoice.type === "required") return { type: "any", ...disableParallel };
  return { type: toolChoice.type, ...disableParallel };
}

function asAnthropicChatMessage(message) {
  return {
    role: message.role,
    content: message.content.map(asAnthropicChatContent),
    ...(message.outputConfig ? { output_config: { effort: message.outputConfig.effort } } : {}),
    ...(message.clearAt ? { clear_at: message.clearAt } : {})
  };
}

function resolveAnthropicThinking(thinking, thinkingDisplay, thinkingPrefixMismatchBehavior) {
  if (thinkingDisplay === null && thinkingPrefixMismatchBehavior === null) return thinking;
  if (!thinking || thinking.type === "disabled") {
    throw new Error("Anthropic thinking display and block binding controls require an enabled or adaptive thinking profile.");
  }
  return {
    ...thinking,
    ...(thinkingDisplay === null ? {} : { display: thinkingDisplay }),
    ...(thinkingPrefixMismatchBehavior === null ? {} : {
      block_binding: {
        ...(thinking.block_binding || {}),
        prefix_mismatch_behavior: thinkingPrefixMismatchBehavior
      }
    })
  };
}

function anthropicBetasFor(messages, thinking) {
  const betas = [];
  if (thinking?.display === "updates") betas.push(THINKING_DISPLAY_UPDATES_BETA);
  if (thinking?.block_binding) betas.push(THINKING_BINDING_CONTROLS_BETA);
  if (messages.some((message) => message.outputConfig)) betas.push(MID_CONVERSATION_EFFORT_BETA);
  if (messages.some((message) => message.clearAt)) betas.push(TURN_SCOPED_SYSTEM_BETA);
  return betas;
}

function progressUpdatesFor(content, thinking) {
  if (thinking?.display !== "updates") return [];
  return content
    .filter((block) => block.type === "thinking" && block.thinking)
    .map((block) => block.thinking);
}

function anthropicResponseMetadata(response, thinking) {
  return {
    stopDetails: response.stop_details || null,
    inputTransformations: response.input_transformations ?? null,
    progressUpdates: progressUpdatesFor(response.content || [], thinking)
  };
}

function asNeutralAnthropicContent(content) {
  return content.flatMap((block) => {
    if (["thinking", "redacted_thinking"].includes(block.type)) {
      return [{ type: "reasoning", provider: "anthropic", data: block }];
    }
    if (block.type === "text") return [{ type: "text", text: block.text || "" }];
    if (block.type === "tool_use") {
      return [{
        type: "tool_call",
        id: block.id,
        name: block.name,
        input: block.input
      }];
    }
    return [];
  });
}

function normalizeAnthropicStopReason(stopReason) {
  if (stopReason === "tool_use") return "tool_call";
  return stopReason || null;
}

function asAnthropicTool(tool, strictTools) {
  const { strict: _strict, ...definition } = tool;
  return {
    ...definition,
    ...(strictTools ? { strict: true } : {})
  };
}

function optionalParameterCount(inputSchema) {
  if (!inputSchema || typeof inputSchema !== "object") return 0;

  let count = 0;
  if (inputSchema.properties) {
    const required = new Set(inputSchema.required || []);
    for (const [name, propertySchema] of Object.entries(inputSchema.properties)) {
      if (!required.has(name)) count += 1;
      count += optionalParameterCount(propertySchema);
    }
  }
  for (const keyword of ["anyOf", "allOf"]) {
    for (const childSchema of inputSchema[keyword] || []) {
      count += optionalParameterCount(childSchema);
    }
  }
  if (inputSchema.items) count += optionalParameterCount(inputSchema.items);
  return count;
}

function unionParameterCount(inputSchema) {
  if (!inputSchema || typeof inputSchema !== "object") return 0;

  let count =
    (Array.isArray(inputSchema.anyOf) && inputSchema.anyOf.length > 0) || Array.isArray(inputSchema.type)
      ? 1
      : 0;
  for (const propertySchema of Object.values(inputSchema.properties || {})) {
    count += unionParameterCount(propertySchema);
  }
  for (const keyword of ["anyOf", "allOf"]) {
    for (const childSchema of inputSchema[keyword] || []) {
      count += unionParameterCount(childSchema);
    }
  }
  if (inputSchema.items) count += unionParameterCount(inputSchema.items);
  return count;
}

function asAnthropicChatTools(tools, strictChatTools) {
  const hasExplicitStrictPolicy = tools.some((tool) => Object.hasOwn(tool, "strict"));
  const requestedStrictTools = hasExplicitStrictPolicy
    ? tools.filter((tool) => tool.strict === true)
    : tools;
  const requestedOptionalParameters = requestedStrictTools.reduce(
    (total, tool) => total + optionalParameterCount(tool.inputSchema),
    0
  );
  const requestedUnionParameters = requestedStrictTools.reduce(
    (total, tool) => total + unionParameterCount(tool.inputSchema),
    0
  );
  const useStrictTools =
    strictChatTools &&
    requestedStrictTools.length <= ANTHROPIC_STRICT_TOOL_LIMIT &&
    requestedOptionalParameters <= ANTHROPIC_STRICT_OPTIONAL_PARAMETER_LIMIT &&
    requestedUnionParameters <= ANTHROPIC_STRICT_UNION_PARAMETER_LIMIT;
  return tools.map((tool) => asAnthropicTool({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema
  }, useStrictTools && (!hasExplicitStrictPolicy || tool.strict === true)));
}

function createAnthropicAdapter({
  apiKey,
  client = null,
  maxRetries = 2,
  timeoutMs = 10 * 60 * 1000,
  cacheTtl = "5m",
  strictDocumentTools = true,
  strictChatTools = true,
  thinkingDisplay = null,
  thinkingPrefixMismatchBehavior = null,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  nowImpl = Date.now,
  randomImpl = Math.random
} = {}) {
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error("maxRetries must be a non-negative integer.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be positive.");
  if (typeof strictDocumentTools !== "boolean") throw new Error("strictDocumentTools must be a boolean.");
  if (typeof strictChatTools !== "boolean") throw new Error("strictChatTools must be a boolean.");
  if (thinkingDisplay !== null && !["summarized", "omitted", "updates"].includes(thinkingDisplay)) {
    throw new Error("thinkingDisplay must be summarized, omitted, updates, or null.");
  }
  if (thinkingPrefixMismatchBehavior !== null && !["error", "drop_block"].includes(thinkingPrefixMismatchBehavior)) {
    throw new Error("thinkingPrefixMismatchBehavior must be error, drop_block, or null.");
  }
  const resolvedCacheTtl = validateCacheTtl(cacheTtl);
  const anthropic = client || new Anthropic({ apiKey, maxRetries: 0, timeout: timeoutMs });

  function messagesClient(betas) {
    const messages = betas.length ? anthropic.beta?.messages : anthropic.messages;
    if (!messages) {
      throw new Error("The configured Anthropic client does not support the beta Messages API required by these options.");
    }
    return messages;
  }

  async function request(params, betas = []) {
    const requestStartedAtMs = nowImpl();
    const attempts = [];
    const api = messagesClient(betas);
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const attemptStartedAtMs = nowImpl();
      try {
        const response = await api.create({
          ...params,
          ...(betas.length ? { betas } : {})
        }, {
          maxRetries: 0,
          timeout: timeoutMs
        });
        const endedAtMs = nowImpl();
        attempts.push(attemptRecord({
          attempt: attempt + 1,
          startedAtMs: attemptStartedAtMs,
          endedAtMs,
          outcome: "success",
          requestId: providerRequestId(response)
        }));
        return {
          response,
          requestTelemetry: requestTelemetry(requestStartedAtMs, endedAtMs, attempts)
        };
      } catch (error) {
        const endedAtMs = nowImpl();
        const retryable = shouldRetryError(error);
        const canRetry = retryable && attempt < maxRetries;
        const delay = canRetry
          ? retryDelay(error?.headers, attempt, { nowMs: endedAtMs, random: randomImpl() })
          : null;
        const isTimeout = error?.name === "AbortError"
          || error?.name === "APIConnectionTimeoutError"
          || error?.code === "ETIMEDOUT";
        attempts.push(attemptRecord({
          attempt: attempt + 1,
          startedAtMs: attemptStartedAtMs,
          endedAtMs,
          outcome: isTimeout
            ? "timeout"
            : error?.status === undefined || error?.status === null
              ? "network_error"
              : retryable
                ? "retryable_error"
                : "error",
          statusCode: error?.status,
          requestId: providerRequestId(error),
          errorType: error?.type || error?.name,
          retryDelayMs: delay
        }));
        if (!canRetry) {
          const telemetry = requestTelemetry(requestStartedAtMs, endedAtMs, attempts);
          throw attachAnthropicError(error, telemetry);
        }
        await sleepImpl(delay);
      }
    }
    throw new Error("Anthropic request exhausted retries without a result.");
  }

  return {
    provider: "anthropic",
    pricingContext: { cacheWriteTtl: resolvedCacheTtl },
    async call({ model, maxOutputTokens, system, userBlocks, tool, effort, thinking }) {
      const resolvedThinking = resolveAnthropicThinking(
        thinking,
        thinkingDisplay,
        thinkingPrefixMismatchBehavior
      );
      const betas = anthropicBetasFor([], resolvedThinking);
      const { response, requestTelemetry: telemetry } = await request({
        model,
        max_tokens: maxOutputTokens,
        system: asAnthropicSystem(system, resolvedCacheTtl),
        messages: [{ role: "user", content: userBlocks.map(asAnthropicContent) }],
        tools: [asAnthropicTool(tool, strictDocumentTools)],
        tool_choice: requiresAutomaticToolChoice(model)
          ? { type: "auto", disable_parallel_tool_use: true }
          : { type: "tool", name: tool.name, disable_parallel_tool_use: true },
        ...(effort ? { output_config: { effort } } : {}),
        ...(resolvedThinking ? { thinking: resolvedThinking } : {})
      }, betas);
      const toolUse = (response.content || []).find((part) => part.type === "tool_use" && part.name === tool.name);
      const usage = response.usage || null;
      return {
        output: toolUse ? toolUse.input : null,
        toolError: toolUse ? null : new Error(`Anthropic did not call required output tool "${tool.name}".`),
        responseContent: response.content || [],
        stopReason: response.stop_reason || null,
        ...anthropicResponseMetadata(response, resolvedThinking),
        usage,
        tokenUsage: normalizeAnthropicUsage(usage),
        model: response.model || model,
        requestTelemetry: telemetry
      };
    },
    async turn({
      model,
      maxOutputTokens,
      system,
      messages,
      tools = [],
      toolChoice,
      parallelToolCalls = true,
      effort,
      thinking,
      webSearch
    }) {
      if (webSearch) throw new Error("The Anthropic adapter does not support the provider-neutral webSearch option.");
      const normalizedMessages = normalizeChatMessages(messages);
      const normalizedTools = normalizeChatTools(tools);
      const normalizedToolChoice = normalizeToolChoice(toolChoice, normalizedTools);
      const resolvedThinking = resolveAnthropicThinking(
        thinking,
        thinkingDisplay,
        thinkingPrefixMismatchBehavior
      );
      const betas = anthropicBetasFor(normalizedMessages, resolvedThinking);
      const { response, requestTelemetry: telemetry } = await request({
        model,
        max_tokens: maxOutputTokens,
        system: asAnthropicSystem(system, resolvedCacheTtl),
        messages: normalizedMessages.map(asAnthropicChatMessage),
        ...(normalizedTools.length ? {
          tools: asAnthropicChatTools(normalizedTools, strictChatTools),
          tool_choice: asAnthropicToolChoice(normalizedToolChoice, parallelToolCalls, model)
        } : {}),
        ...(effort ? { output_config: { effort } } : {}),
        ...(resolvedThinking ? { thinking: resolvedThinking } : {})
      }, betas);
      const usage = response.usage || null;
      return {
        message: {
          role: "assistant",
          content: asNeutralAnthropicContent(response.content || [])
        },
        toolError: null,
        responseId: response.id || null,
        responseContent: response.content || [],
        stopReason: normalizeAnthropicStopReason(response.stop_reason),
        ...anthropicResponseMetadata(response, resolvedThinking),
        usage,
        tokenUsage: normalizeAnthropicUsage(usage),
        model: response.model || model,
        requestTelemetry: telemetry
      };
    },
    async *streamTurn({
      model,
      maxOutputTokens,
      system,
      messages,
      tools = [],
      toolChoice,
      parallelToolCalls = true,
      effort,
      thinking,
      webSearch
    }) {
      if (webSearch) throw new Error("The Anthropic adapter does not support the provider-neutral webSearch option.");
      const normalizedMessages = normalizeChatMessages(messages);
      const normalizedTools = normalizeChatTools(tools);
      const normalizedToolChoice = normalizeToolChoice(toolChoice, normalizedTools);
      const resolvedThinking = resolveAnthropicThinking(
        thinking,
        thinkingDisplay,
        thinkingPrefixMismatchBehavior
      );
      const betas = anthropicBetasFor(normalizedMessages, resolvedThinking);
      const params = {
        model,
        max_tokens: maxOutputTokens,
        system: asAnthropicSystem(system, resolvedCacheTtl),
        messages: normalizedMessages.map(asAnthropicChatMessage),
        ...(normalizedTools.length ? {
          tools: asAnthropicChatTools(normalizedTools, strictChatTools),
          tool_choice: asAnthropicToolChoice(normalizedToolChoice, parallelToolCalls, model)
        } : {}),
        ...(effort ? { output_config: { effort } } : {}),
        ...(resolvedThinking ? { thinking: resolvedThinking } : {}),
        ...(betas.length ? { betas } : {})
      };
      const requestStartedAtMs = nowImpl();
      const attempts = [];

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const attemptStartedAtMs = nowImpl();
        const toolCallsByIndex = new Map();
        let deliveredOutput = false;
        try {
          const stream = messagesClient(betas).stream(params, {
            maxRetries: 0,
            timeout: timeoutMs
          });
          for await (const event of stream) {
            if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
              const toolCall = {
                id: event.content_block.id,
                name: event.content_block.name
              };
              toolCallsByIndex.set(event.index, toolCall);
              deliveredOutput = true;
              yield { type: "tool_call_start", ...toolCall };
            } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
              deliveredOutput = true;
              yield { type: "text_delta", text: event.delta.text || "" };
            } else if (
              event.type === "content_block_delta" &&
              event.delta?.type === "thinking_delta" &&
              resolvedThinking?.display === "updates" &&
              event.delta.thinking
            ) {
              deliveredOutput = true;
              yield { type: "progress_delta", text: event.delta.thinking };
            } else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
              const toolCall = toolCallsByIndex.get(event.index);
              if (toolCall) {
                deliveredOutput = true;
                yield {
                  type: "tool_call_delta",
                  id: toolCall.id,
                  inputJsonDelta: event.delta.partial_json || ""
                };
              }
            }
          }

          const response = await stream.finalMessage();
          const endedAtMs = nowImpl();
          attempts.push(attemptRecord({
            attempt: attempt + 1,
            startedAtMs: attemptStartedAtMs,
            endedAtMs,
            outcome: "success",
            requestId: providerRequestId(response)
          }));
          const usage = response.usage || null;
          yield {
            type: "done",
            result: {
              message: {
                role: "assistant",
                content: asNeutralAnthropicContent(response.content || [])
              },
              toolError: null,
              responseId: response.id || null,
              responseContent: response.content || [],
              stopReason: normalizeAnthropicStopReason(response.stop_reason),
              ...anthropicResponseMetadata(response, resolvedThinking),
              usage,
              tokenUsage: normalizeAnthropicUsage(usage),
              model: response.model || model,
              requestTelemetry: requestTelemetry(requestStartedAtMs, endedAtMs, attempts)
            }
          };
          return;
        } catch (error) {
          const endedAtMs = nowImpl();
          const retryable = shouldRetryError(error);
          const canRetry = retryable && !deliveredOutput && attempt < maxRetries;
          const delay = canRetry
            ? retryDelay(error?.headers, attempt, { nowMs: endedAtMs, random: randomImpl() })
            : null;
          const isTimeout = error?.name === "AbortError"
            || error?.name === "APIConnectionTimeoutError"
            || error?.code === "ETIMEDOUT";
          attempts.push(attemptRecord({
            attempt: attempt + 1,
            startedAtMs: attemptStartedAtMs,
            endedAtMs,
            outcome: isTimeout
              ? "timeout"
              : error?.status === undefined || error?.status === null
                ? "network_error"
                : retryable
                  ? "retryable_error"
                  : "error",
            statusCode: error?.status,
            requestId: providerRequestId(error),
            errorType: error?.type || error?.name,
            retryDelayMs: delay
          }));
          if (!canRetry) {
            throw attachAnthropicError(
              error,
              requestTelemetry(requestStartedAtMs, endedAtMs, attempts)
            );
          }
          await sleepImpl(delay);
        }
      }
    }
  };
}

module.exports = { createAnthropicAdapter, asAnthropicContent, asAnthropicSystem };
