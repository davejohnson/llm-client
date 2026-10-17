const { normalizeOpenAIUsage } = require("./tokenUsage");
const { normalizeStrictSchema, restoreOptionalProperties } = require("./strictSchema");
const { normalizeChatMessages, normalizeChatTools, normalizeToolChoice, normalizeWebSearch } = require("./chatTurn");
const { mediaTypeForDocument, textForDocument } = require("./documentContent");
const {
  attachProviderError,
  normalizeProviderFailure
} = require("./providerErrors");
const {
  attachRequestTelemetry,
  attemptRecord,
  providerRequestId,
  requestTelemetry,
  retryDelay,
  retryableStatus
} = require("./requestTelemetry");

function responsesErrorDetails(error, provider, retryableOverride = null) {
  return normalizeProviderFailure({
    provider,
    code: error?.code,
    type: error?.type,
    statusCode: error?.status,
    retryable: retryableOverride
  });
}

function attachResponsesError(error, telemetry, provider, details = responsesErrorDetails(error, provider)) {
  return attachProviderError(attachRequestTelemetry(error, telemetry), {
    ...details,
    requestId: details.requestId
      || providerRequestId(error)
      || telemetry.providerRequestId
  });
}

function asOpenAIContent(block, { pdfDetail = "low", providerLabel = "OpenAI" } = {}) {
  if (block.type === "text") return { type: "input_text", text: block.text };
  if (block.type === "document") {
    const text = textForDocument(block);
    if (text !== null) return { type: "input_text", text };
    const mediaType = mediaTypeForDocument(block);
    const dataBase64 = block.dataBase64 || block.source?.data;
    return {
      type: "input_file",
      filename: block.filename || "document.pdf",
      file_data: `data:${mediaType};base64,${dataBase64}`,
      ...(mediaType === "application/pdf" ? { detail: block.detail || pdfDetail } : {})
    };
  }
  if (block.type === "image") {
    const mediaType = block.mediaType || block.source?.media_type;
    const dataBase64 = block.dataBase64 || block.source?.data;
    return { type: "input_image", image_url: `data:${mediaType};base64,${dataBase64}` };
  }
  throw new Error(`Unsupported ${providerLabel} document block type: ${block.type}.`);
}

function asOpenAIInstructions(system) {
  return Array.isArray(system)
    ? system.map((block) => block.text || "").join("\n")
    : String(system || "");
}

function stringifyToolOutput(output) {
  return typeof output === "string" ? output : JSON.stringify(output);
}

function asOpenAIChatInput(messages, {
  pdfDetail = "low",
  provider = "openai",
  providerLabel = "OpenAI",
  allowDeveloperMessages = false
} = {}) {
  const input = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (!allowDeveloperMessages) {
        throw new Error("Mid-conversation system messages are only supported by the Anthropic and Meta adapters.");
      }
      if (message.outputConfig || message.clearAt) {
        throw new Error("Meta mid-conversation system messages do not support Anthropic outputConfig or clearAt controls.");
      }
      if (message.content.some((block) => block.type !== "text")) {
        throw new Error("Meta mid-conversation system messages only support text blocks.");
      }
      input.push({
        role: "developer",
        content: message.content.map((block) => block.text).join("\n")
      });
      continue;
    }
    let content = [];
    let contentPhase;
    const flushContent = () => {
      if (!content.length) return;
      if (message.role === "assistant") {
        if (content.some((block) => block.type !== "text")) {
          throw new Error("Assistant chat messages only support text and tool_call blocks.");
        }
        input.push({
          role: "assistant",
          ...(contentPhase === undefined ? {} : { phase: contentPhase }),
          content: content.map((block) => block.text).join("\n")
        });
      } else {
        input.push({
          role: "user",
          content: content.map((block) => asOpenAIContent(block, { pdfDetail, providerLabel }))
        });
      }
      content = [];
      contentPhase = undefined;
    };

    for (const block of message.content) {
      if (block.type === "reasoning") {
        flushContent();
        if (block.provider !== provider) {
          throw new Error(`Cannot replay ${block.provider} reasoning through the ${providerLabel} adapter.`);
        }
        if (block.data?.type !== "reasoning") {
          throw new Error(`Unsupported ${providerLabel} reasoning block type: ${block.data?.type || "unknown"}.`);
        }
        input.push(block.data);
      } else if (block.type === "tool_call") {
        flushContent();
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input)
        });
      } else if (block.type === "tool_result") {
        flushContent();
        const output = stringifyToolOutput(block.output);
        input.push({
          type: "function_call_output",
          call_id: block.toolCallId,
          output: block.isError ? `Tool error: ${output}` : output
        });
      } else {
        if (message.role === "assistant" && block.type === "text") {
          if (content.length && block.phase !== contentPhase) flushContent();
          if (!content.length) contentPhase = block.phase;
        }
        content.push(block);
      }
    }
    flushContent();
  }
  return input;
}

function asOpenAITool(tool) {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: normalizeStrictSchema(tool.inputSchema),
    strict: true
  };
}

function asOpenAIToolChoice(toolChoice) {
  if (toolChoice.type === "tool") return { type: "function", name: toolChoice.name };
  return toolChoice.type;
}

async function* openAISseEvents(body, providerLabel = "OpenAI") {
  if (!body) throw new Error(`${providerLabel} streaming response did not include a body.`);
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      const separator = /^\r?\n\r?\n/.exec(buffer.slice(boundary))[0];
      buffer = buffer.slice(boundary + separator.length);
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data && data !== "[DONE]") yield JSON.parse(data);
      boundary = buffer.search(/\r?\n\r?\n/);
    }
  }

  buffer += decoder.decode();
  const data = buffer
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data && data !== "[DONE]") yield JSON.parse(data);
}

async function readResponseBody(response) {
  try {
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return null;
  }
}

function responsesError(response, body, providerLabel) {
  const error = new Error(`${providerLabel} ${response.status}: ${body?.error?.message || response.statusText || "Request failed"}`);
  error.status = response.status;
  error.type = body?.error?.type;
  error.code = body?.error?.code;
  error.param = body?.error?.param;
  error.requestId = providerRequestId(response);
  error.headers = response.headers;
  return error;
}

function hasIncompleteJsonStructure(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return true;

  const closing = { "{": "}", "[": "]" };
  const stack = [];
  let escaped = false;
  let inString = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") inString = true;
    else if (closing[character]) stack.push(closing[character]);
    else if (character === "}" || character === "]") {
      if (stack.pop() !== character) return false;
    }
  }
  return inString || stack.length > 0;
}

function isIncompleteJson(value, error) {
  if (!value || /unexpected end|unterminated string/i.test(error?.message || "")) return true;
  const position = /position (\d+)/i.exec(error?.message || "");
  if (position && Number(position[1]) >= value.trimEnd().length) return true;
  return !position && hasIncompleteJsonStructure(value);
}

function asOpenAIChatResult(body, model, tools, {
  provider = "openai",
  providerLabel = "OpenAI"
} = {}) {
  const content = [];
  const citations = [];
  const webSearchCalls = [];
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  let hasToolCall = false;
  let refused = false;
  let maxTokens = body.incomplete_details?.reason === "max_output_tokens";
  let toolError = null;

  for (const item of body.output || []) {
    if (item.type === "reasoning") {
      content.push({ type: "reasoning", provider, data: item });
      continue;
    }
    if (item.type === "web_search_call") {
      webSearchCalls.push(item);
      continue;
    }
    if (item.type === "message") {
      for (const part of item.content || []) {
        const phase = item.phase === undefined || item.phase === null ? {} : { phase: item.phase };
        if (part.type === "output_text") {
          const text = part.text || "";
          content.push({ type: "text", text, ...phase });
          for (const annotation of part.annotations || []) {
            if (annotation.type !== "url_citation") continue;
            const startIndex = Number.isInteger(annotation.start_index) ? annotation.start_index : null;
            const endIndex = Number.isInteger(annotation.end_index) ? annotation.end_index : null;
            citations.push({
              type: "url_citation",
              url: annotation.url || null,
              title: annotation.title || null,
              startIndex,
              endIndex,
              citedText: startIndex === null || endIndex === null
                ? null
                : text.slice(startIndex, endIndex)
            });
          }
        }
        else if (part.type === "refusal") {
          refused = true;
          content.push({ type: "text", text: part.refusal || "", ...phase });
        }
      }
      continue;
    }
    if (item.type !== "function_call") continue;

    hasToolCall = true;
    try {
      const parsed = JSON.parse(item.arguments);
      const schema = toolsByName.get(item.name)?.inputSchema;
      content.push({
        type: "tool_call",
        id: item.call_id || item.id,
        name: item.name,
        input: restoreOptionalProperties(parsed, schema)
      });
    } catch (error) {
      maxTokens ||= isIncompleteJson(item.arguments, error);
      if (!maxTokens && !toolError) {
        toolError = new Error(`${providerLabel} returned invalid arguments for chat tool "${item.name}": ${error.message}`);
      }
    }
  }

  const usage = body.usage || null;
  const stopReason = maxTokens
    ? "max_tokens"
    : hasToolCall
      ? "tool_call"
      : refused
        ? "refusal"
        : body.status === "completed"
          ? "end_turn"
          : body.incomplete_details?.reason || body.status || null;
  return {
    message: { role: "assistant", content },
    toolError,
    responseId: body.id || null,
    responseContent: body.output || [],
    citations,
    webSearchCalls,
    stopReason,
    usage,
    tokenUsage: normalizeOpenAIUsage(usage),
    model: body.model || model
  };
}

function createResponsesAdapter({
  apiKey,
  baseUrl = null,
  fetchImpl = fetch,
  maxRetries = 2,
  timeoutMs = 10 * 60 * 1000,
  pdfDetail = null,
  promptCacheRetention = null,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  nowImpl = Date.now,
  randomImpl = Math.random
} = {}, {
  provider = "openai",
  providerLabel = "OpenAI",
  defaultBaseUrl = "https://api.openai.com/v1",
  structuredOutputMode = "function",
  automaticToolChoiceOnly = false,
  allowDeveloperMessages = false,
  includeEncryptedReasoning = false
} = {}) {
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error("maxRetries must be a non-negative integer.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be positive.");
  if (pdfDetail !== null && !["auto", "low", "high"].includes(pdfDetail)) throw new Error("pdfDetail must be auto, low, or high.");
  if (promptCacheRetention !== null && !["in_memory", "24h"].includes(promptCacheRetention)) {
    throw new Error("promptCacheRetention must be in_memory, 24h, or null.");
  }
  const resolvedBaseUrl = baseUrl || defaultBaseUrl;

  function requestExtras(promptCacheKey, model) {
    const usesGpt6Cache = provider === "openai" && ["gpt-6-sol", "gpt-6-luna"].includes(model);
    if (usesGpt6Cache && promptCacheRetention !== null) {
      throw new Error("GPT-6 Sol and Luna do not support promptCacheRetention; omit it to use the 30m cache TTL.");
    }
    return {
      ...(includeEncryptedReasoning ? {
        include: ["reasoning.encrypted_content"],
        store: false
      } : {}),
      ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
      ...(usesGpt6Cache ? { prompt_cache_options: { ttl: "30m" } } : {}),
      ...(promptCacheRetention ? { prompt_cache_retention: promptCacheRetention } : {})
    };
  }

  async function request(requestBody) {
    const requestStartedAtMs = nowImpl();
    const attempts = [];
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const attemptStartedAtMs = nowImpl();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();
      let response;
      let body;
      try {
        response = await fetchImpl(`${resolvedBaseUrl.replace(/\/$/, "")}/responses`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
        body = await readResponseBody(response);
      } catch (error) {
        clearTimeout(timeout);
        const endedAtMs = nowImpl();
        const canRetry = attempt < maxRetries;
        const delay = canRetry
          ? retryDelay(error?.headers || response?.headers, attempt, { nowMs: endedAtMs, random: randomImpl() })
          : null;
        attempts.push(attemptRecord({
          attempt: attempt + 1,
          startedAtMs: attemptStartedAtMs,
          endedAtMs,
          outcome: error?.name === "AbortError" ? "timeout" : "network_error",
          statusCode: error?.status || response?.status,
          requestId: providerRequestId(error) || providerRequestId(response),
          errorType: error?.type || error?.name,
          retryDelayMs: delay
        }));
        if (!canRetry) {
          const telemetry = requestTelemetry(requestStartedAtMs, endedAtMs, attempts);
          throw attachResponsesError(
            error,
            telemetry,
            provider,
            responsesErrorDetails(error, provider, true)
          );
        }
        await sleepImpl(delay);
        continue;
      }
      clearTimeout(timeout);
      const endedAtMs = nowImpl();
      const requestId = providerRequestId(response);
      if (response.ok) {
        attempts.push(attemptRecord({
          attempt: attempt + 1,
          startedAtMs: attemptStartedAtMs,
          endedAtMs,
          outcome: "success",
          statusCode: response.status,
          requestId
        }));
        return {
          body,
          requestTelemetry: requestTelemetry(requestStartedAtMs, endedAtMs, attempts)
        };
      }

      const error = responsesError(response, body, providerLabel);
      const errorDetails = responsesErrorDetails(error, provider);
      const canRetry = errorDetails.retryable && attempt < maxRetries;
      const delay = canRetry
        ? retryDelay(response.headers, attempt, { nowMs: endedAtMs, random: randomImpl() })
        : null;
      attempts.push(attemptRecord({
        attempt: attempt + 1,
        startedAtMs: attemptStartedAtMs,
        endedAtMs,
        outcome: errorDetails.retryable ? "retryable_error" : "error",
        statusCode: response.status,
        requestId,
        errorType: error.type,
        retryDelayMs: delay
      }));
      if (!canRetry) {
        const telemetry = requestTelemetry(requestStartedAtMs, endedAtMs, attempts);
        throw attachResponsesError(error, telemetry, provider, errorDetails);
      }
      try { await response.body?.cancel?.(); } catch {}
      await sleepImpl(delay);
    }
    throw new Error(`${providerLabel} request exhausted retries without a result.`);
  }

  async function startStream(requestBody) {
    const requestStartedAtMs = nowImpl();
    const attempts = [];
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const attemptStartedAtMs = nowImpl();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();
      let response;
      try {
        response = await fetchImpl(`${resolvedBaseUrl.replace(/\/$/, "")}/responses`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ...requestBody, stream: true }),
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timeout);
        const endedAtMs = nowImpl();
        const canRetry = attempt < maxRetries;
        const delay = canRetry
          ? retryDelay(error?.headers || response?.headers, attempt, { nowMs: endedAtMs, random: randomImpl() })
          : null;
        attempts.push(attemptRecord({
          attempt: attempt + 1,
          startedAtMs: attemptStartedAtMs,
          endedAtMs,
          outcome: error?.name === "AbortError" ? "timeout" : "network_error",
          statusCode: error?.status || response?.status,
          requestId: providerRequestId(error) || providerRequestId(response),
          errorType: error?.type || error?.name,
          retryDelayMs: delay
        }));
        if (!canRetry) {
          throw attachResponsesError(
            error,
            requestTelemetry(requestStartedAtMs, endedAtMs, attempts),
            provider,
            responsesErrorDetails(error, provider, true)
          );
        }
        await sleepImpl(delay);
        continue;
      }

      if (response.ok) {
        return {
          response,
          controller,
          timeout,
          requestStartedAtMs,
          attemptStartedAtMs,
          attempt: attempt + 1,
          attempts
        };
      }

      clearTimeout(timeout);
      const body = await readResponseBody(response);
      const endedAtMs = nowImpl();
      const error = responsesError(response, body, providerLabel);
      const errorDetails = responsesErrorDetails(error, provider);
      const canRetry = errorDetails.retryable && attempt < maxRetries;
      const delay = canRetry
        ? retryDelay(response.headers, attempt, { nowMs: endedAtMs, random: randomImpl() })
        : null;
      attempts.push(attemptRecord({
        attempt: attempt + 1,
        startedAtMs: attemptStartedAtMs,
        endedAtMs,
        outcome: errorDetails.retryable ? "retryable_error" : "error",
        statusCode: response.status,
        requestId: providerRequestId(response),
        errorType: error.type,
        retryDelayMs: delay
      }));
      if (!canRetry) {
        throw attachResponsesError(
          error,
          requestTelemetry(requestStartedAtMs, endedAtMs, attempts),
          provider,
          errorDetails
        );
      }
      try { await response.body?.cancel?.(); } catch {}
      await sleepImpl(delay);
    }
    throw new Error(`${providerLabel} streaming request exhausted retries without a result.`);
  }

  function chatToolFields(normalizedTools, normalizedToolChoice, parallelToolCalls, normalizedWebSearch) {
    if (automaticToolChoiceOnly && ["required", "tool"].includes(normalizedToolChoice.type)) {
      throw new Error("Muse Spark only supports automatic tool choice; use auto or omit tools for a no-tool turn.");
    }
    if (automaticToolChoiceOnly && normalizedToolChoice.type === "none") return {};

    const requestTools = [
      ...normalizedTools.map(asOpenAITool),
      ...(normalizedWebSearch ? [{
        type: "web_search",
        ...(normalizedWebSearch.searchContextSize
          ? { search_context_size: normalizedWebSearch.searchContextSize }
          : {})
      }] : [])
    ];
    if (!requestTools.length) return {};
    return {
      tools: requestTools,
      ...(!automaticToolChoiceOnly ? { tool_choice: asOpenAIToolChoice(normalizedToolChoice) } : {}),
      ...(normalizedTools.length ? { parallel_tool_calls: parallelToolCalls } : {})
    };
  }

  return {
    provider,
    async call({ model, maxOutputTokens, system, userBlocks, tool, promptCacheKey, pdfDetail: profilePdfDetail, reasoningEffort }) {
      const resolvedPdfDetail = pdfDetail || profilePdfDetail || "low";
      const normalizedSchema = normalizeStrictSchema(tool.input_schema);
      const requestBody = {
        model,
        max_output_tokens: maxOutputTokens,
        instructions: asOpenAIInstructions(system),
        input: [{
          role: "user",
          content: userBlocks.map((block) => asOpenAIContent(block, {
            pdfDetail: resolvedPdfDetail,
            providerLabel
          }))
        }],
        ...(structuredOutputMode === "json_schema" ? {
          text: {
            format: {
              type: "json_schema",
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              schema: normalizedSchema,
              strict: true
            }
          }
        } : {
          tools: [{
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: normalizedSchema,
            strict: true
          }],
          tool_choice: { type: "function", name: tool.name }
        }),
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
        ...requestExtras(promptCacheKey, model)
      };
      const { body, requestTelemetry: telemetry } = await request(requestBody);
      const functionCall = (body.output || []).find((item) => (
        item.type === "function_call" && item.name === tool.name
      ));
      const structuredText = (body.output || [])
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content || [])
        .filter((part) => part.type === "output_text")
        .map((part) => part.text || "")
        .join("");
      const encodedOutput = structuredOutputMode === "json_schema"
        ? structuredText
        : functionCall?.arguments;
      let maxTokens = body.incomplete_details?.reason === "max_output_tokens";
      let output = null;
      let toolError = encodedOutput || maxTokens
        ? null
        : new Error(structuredOutputMode === "json_schema"
          ? `${providerLabel} did not return required structured output "${tool.name}".`
          : `${providerLabel} did not call required output tool "${tool.name}".`);
      if (encodedOutput) {
        try {
          output = restoreOptionalProperties(JSON.parse(encodedOutput), tool.input_schema);
        } catch (error) {
          maxTokens ||= isIncompleteJson(encodedOutput, error);
          if (!maxTokens) {
            toolError = new Error(structuredOutputMode === "json_schema"
              ? `${providerLabel} returned invalid structured output "${tool.name}": ${error.message}`
              : `${providerLabel} returned invalid arguments for output tool "${tool.name}": ${error.message}`);
          }
        }
      }
      const usage = body.usage || null;
      return {
        output,
        toolError,
        responseId: body.id || null,
        responseContent: body.output || [],
        stopReason: maxTokens ? "max_tokens" : body.status || null,
        usage,
        tokenUsage: normalizeOpenAIUsage(usage),
        model: body.model || model,
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
      promptCacheKey,
      pdfDetail: profilePdfDetail,
      reasoningEffort,
      webSearch
    }) {
      const normalizedMessages = normalizeChatMessages(messages);
      const normalizedTools = normalizeChatTools(tools);
      const normalizedWebSearch = normalizeWebSearch(webSearch);
      const normalizedToolChoice = normalizeToolChoice(
        toolChoice,
        normalizedTools,
        Boolean(normalizedWebSearch)
      );
      const resolvedPdfDetail = pdfDetail || profilePdfDetail || "low";
      const requestBody = {
        model,
        max_output_tokens: maxOutputTokens,
        instructions: asOpenAIInstructions(system),
        store: false,
        input: asOpenAIChatInput(normalizedMessages, {
          pdfDetail: resolvedPdfDetail,
          provider,
          providerLabel,
          allowDeveloperMessages
        }),
        ...chatToolFields(normalizedTools, normalizedToolChoice, parallelToolCalls, normalizedWebSearch),
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
        ...requestExtras(promptCacheKey, model)
      };
      const { body, requestTelemetry: telemetry } = await request(requestBody);
      return {
        ...asOpenAIChatResult(body, model, normalizedTools, { provider, providerLabel }),
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
      promptCacheKey,
      pdfDetail: profilePdfDetail,
      reasoningEffort,
      webSearch
    }) {
      const normalizedMessages = normalizeChatMessages(messages);
      const normalizedTools = normalizeChatTools(tools);
      const normalizedWebSearch = normalizeWebSearch(webSearch);
      const normalizedToolChoice = normalizeToolChoice(
        toolChoice,
        normalizedTools,
        Boolean(normalizedWebSearch)
      );
      const resolvedPdfDetail = pdfDetail || profilePdfDetail || "low";
      const requestBody = {
        model,
        max_output_tokens: maxOutputTokens,
        instructions: asOpenAIInstructions(system),
        store: false,
        input: asOpenAIChatInput(normalizedMessages, {
          pdfDetail: resolvedPdfDetail,
          provider,
          providerLabel,
          allowDeveloperMessages
        }),
        ...chatToolFields(normalizedTools, normalizedToolChoice, parallelToolCalls, normalizedWebSearch),
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
        ...requestExtras(promptCacheKey, model)
      };
      const stream = await startStream(requestBody);
      const toolCalls = new Map();
      let completedResponse = null;
      let deliveredOutput = false;

      try {
        for await (const event of openAISseEvents(stream.response.body, providerLabel)) {
          if (event.type === "response.output_text.delta") {
            deliveredOutput = true;
            yield { type: "text_delta", text: event.delta || "" };
          } else if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
            const id = event.item.call_id || event.item.id;
            const toolCall = { id, name: event.item.name };
            if (event.item.id) toolCalls.set(event.item.id, toolCall);
            if (event.item.call_id) toolCalls.set(event.item.call_id, toolCall);
            deliveredOutput = true;
            yield { type: "tool_call_start", ...toolCall };
          } else if (event.type === "response.function_call_arguments.delta") {
            const toolCall = toolCalls.get(event.item_id) || toolCalls.get(event.call_id);
            if (toolCall) {
              deliveredOutput = true;
              yield {
                type: "tool_call_delta",
                id: toolCall.id,
                inputJsonDelta: event.delta || ""
              };
            }
          } else if (event.type === "response.completed") {
            completedResponse = event.response;
          } else if (event.type === "error") {
            const error = new Error(event.message || event.error?.message || `${providerLabel} stream failed.`);
            error.code = event.code || event.error?.code;
            error.type = event.error?.type;
            error.param = event.param || event.error?.param;
            throw error;
          }
        }

        if (!completedResponse) {
          throw new Error(`${providerLabel} stream ended without a completed response.`);
        }
        clearTimeout(stream.timeout);
        const endedAtMs = nowImpl();
        stream.attempts.push(attemptRecord({
          attempt: stream.attempt,
          startedAtMs: stream.attemptStartedAtMs,
          endedAtMs,
          outcome: "success",
          statusCode: stream.response.status,
          requestId: providerRequestId(stream.response)
        }));
        yield {
          type: "done",
          result: {
            ...asOpenAIChatResult(completedResponse, model, normalizedTools, { provider, providerLabel }),
            requestTelemetry: requestTelemetry(
              stream.requestStartedAtMs,
              endedAtMs,
              stream.attempts
            )
          }
        };
      } catch (error) {
        clearTimeout(stream.timeout);
        stream.controller.abort();
        const endedAtMs = nowImpl();
        const errorDetails = responsesErrorDetails(error, provider);
        const providerFailure = Boolean(error?.code || error?.type);
        stream.attempts.push(attemptRecord({
          attempt: stream.attempt,
          startedAtMs: stream.attemptStartedAtMs,
          endedAtMs,
          outcome:
            error?.name === "AbortError"
              ? "timeout"
              : providerFailure
                ? errorDetails.retryable
                  ? "retryable_error"
                  : "error"
                : "network_error",
          statusCode: stream.response.status,
          requestId: providerRequestId(stream.response),
          errorType: error?.type || error?.name
        }));
        error.deliveredOutput = deliveredOutput;
        throw attachResponsesError(
          error,
          requestTelemetry(stream.requestStartedAtMs, endedAtMs, stream.attempts),
          provider,
          errorDetails
        );
      }
    }
  };
}

function createOpenAIAdapter(options = {}) {
  return createResponsesAdapter(options);
}

module.exports = {
  createOpenAIAdapter,
  createResponsesAdapter,
  asOpenAIChatInput,
  asOpenAIContent,
  isIncompleteJson,
  openAISseEvents,
  retryableStatus
};
