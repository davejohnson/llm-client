function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function normalizeOpenAIUsage(usage) {
  if (!usage) return null;
  const inputTokens = numberOrZero(usage.input_tokens);
  const cachedInputTokens = numberOrZero(usage.input_tokens_details?.cached_tokens);
  const cacheWriteInputTokens = numberOrZero(usage.input_tokens_details?.cache_write_tokens);
  const outputTokens = numberOrZero(usage.output_tokens);
  return {
    inputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheWriteInputTokens),
    cachedInputTokens,
    cacheWriteInputTokens,
    cacheWrite5mInputTokens: 0,
    cacheWrite1hInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: numberOrZero(usage.output_tokens_details?.reasoning_tokens),
    totalTokens: numberOrZero(usage.total_tokens) || inputTokens + outputTokens
  };
}

function normalizeAnthropicUsage(usage) {
  if (!usage) return null;
  const uncachedInputTokens = numberOrZero(usage.input_tokens);
  const cachedInputTokens = numberOrZero(usage.cache_read_input_tokens);
  const cacheWrite5mInputTokens = numberOrZero(usage.cache_creation?.ephemeral_5m_input_tokens);
  const cacheWrite1hInputTokens = numberOrZero(usage.cache_creation?.ephemeral_1h_input_tokens);
  const categorizedCacheWriteTokens = cacheWrite5mInputTokens + cacheWrite1hInputTokens;
  const cacheWriteInputTokens = Number.isFinite(usage.cache_creation_input_tokens)
    ? usage.cache_creation_input_tokens
    : categorizedCacheWriteTokens;
  const inputTokens = uncachedInputTokens + cachedInputTokens + cacheWriteInputTokens;
  const outputTokens = numberOrZero(usage.output_tokens);
  return {
    inputTokens,
    uncachedInputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    cacheWrite5mInputTokens,
    cacheWrite1hInputTokens,
    outputTokens,
    reasoningOutputTokens: numberOrZero(usage.output_tokens_details?.thinking_tokens),
    totalTokens: inputTokens + outputTokens
  };
}

module.exports = { normalizeOpenAIUsage, normalizeAnthropicUsage };
