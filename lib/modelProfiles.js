const MODEL_MAX_OUTPUT_TOKENS = 128000;

function openAIDocumentProfile(model) {
  return {
    id: `openai/${model}`,
    provider: "openai",
    model,
    pagesPerChunk: 20,
    overlapPages: 2,
    maxOutputTokens: 12000,
    modelMaxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
    maxSplitDepth: 3,
    pdfDetail: "low",
    reasoningEffort: "none"
  };
}

function openAIChatProfile(model) {
  return {
    id: `openai/${model}-chat`,
    provider: "openai",
    model,
    maxOutputTokens: 12000,
    modelMaxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
    reasoningEffort: "low"
  };
}

const BUILTIN_MODEL_PROFILES = Object.freeze({
  "anthropic/claude-haiku-5-5": {
    id: "anthropic/claude-haiku-5-5",
    provider: "anthropic",
    model: "claude-haiku-5-5",
    maxOutputTokens: 16000,
    modelMaxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
    effort: "medium",
    thinking: { type: "adaptive" }
  },
  "anthropic/claude-haiku-4-5": {
    id: "anthropic/claude-haiku-4-5",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    maxOutputTokens: 16000,
    modelMaxOutputTokens: 64000
  },
  "anthropic/claude-opus-4-8": {
    id: "anthropic/claude-opus-4-8",
    provider: "anthropic",
    model: "claude-opus-4-8",
    pagesPerChunk: 30,
    overlapPages: 3,
    maxOutputTokens: 16000,
    modelMaxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
    maxSplitDepth: 3,
    effort: "medium",
    thinking: { type: "disabled" }
  },
  "anthropic/claude-opus-4-8-dense": {
    id: "anthropic/claude-opus-4-8-dense",
    provider: "anthropic",
    model: "claude-opus-4-8",
    pagesPerChunk: 12,
    overlapPages: 3,
    maxOutputTokens: 16000,
    modelMaxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
    maxSplitDepth: 3,
    effort: "medium",
    thinking: { type: "disabled" }
  },
  "anthropic/claude-opus-5": {
    id: "anthropic/claude-opus-5",
    provider: "anthropic",
    model: "claude-opus-5",
    pagesPerChunk: 30,
    overlapPages: 3,
    maxOutputTokens: 16000,
    modelMaxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
    maxSplitDepth: 3,
    effort: "high",
    thinking: { type: "adaptive" }
  },
  "anthropic/claude-opus-5-5": {
    id: "anthropic/claude-opus-5-5",
    provider: "anthropic",
    model: "claude-opus-5-5",
    pagesPerChunk: 30,
    overlapPages: 3,
    maxOutputTokens: 16000,
    modelMaxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
    maxSplitDepth: 3,
    effort: "medium",
    thinking: { type: "adaptive" }
  },
  "anthropic/claude-fable-5-1": {
    id: "anthropic/claude-fable-5-1",
    provider: "anthropic",
    model: "claude-fable-5-1",
    pagesPerChunk: 30,
    overlapPages: 3,
    maxOutputTokens: 16000,
    modelMaxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
    maxSplitDepth: 3,
    effort: "high",
    thinking: { type: "adaptive" }
  },
  "anthropic/claude-mythos-5-1": {
    id: "anthropic/claude-mythos-5-1",
    provider: "anthropic",
    model: "claude-mythos-5-1",
    pagesPerChunk: 30,
    overlapPages: 3,
    maxOutputTokens: 16000,
    modelMaxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
    maxSplitDepth: 3,
    effort: "high",
    thinking: { type: "adaptive" }
  },
  "anthropic/claude-sonnet-5-5": {
    id: "anthropic/claude-sonnet-5-5",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    pagesPerChunk: 24,
    overlapPages: 3,
    maxOutputTokens: 12000,
    modelMaxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
    maxSplitDepth: 3,
    effort: "high",
    thinking: { type: "adaptive" }
  },
  "anthropic/claude-sonnet-5": {
    id: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    model: "claude-sonnet-5",
    pagesPerChunk: 24,
    overlapPages: 3,
    maxOutputTokens: 12000,
    modelMaxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
    maxSplitDepth: 3,
    effort: "medium",
    thinking: { type: "disabled" }
  },
  "anthropic/claude-sonnet-5-chat": {
    id: "anthropic/claude-sonnet-5-chat",
    provider: "anthropic",
    model: "claude-sonnet-5",
    maxOutputTokens: 12000,
    modelMaxOutputTokens: MODEL_MAX_OUTPUT_TOKENS,
    effort: "medium",
    thinking: { type: "adaptive" }
  },
  "meta/muse-spark-1.3": {
    id: "meta/muse-spark-1.3",
    provider: "meta",
    model: "muse-spark-1.3",
    pagesPerChunk: 20,
    overlapPages: 2,
    maxOutputTokens: 12000,
    modelMaxOutputTokens: 131072,
    maxSplitDepth: 3,
    pdfDetail: "low",
    reasoningEffort: "high"
  },
  "openai/gpt-5.4": openAIDocumentProfile("gpt-5.4"),
  "openai/gpt-5.4-mini": openAIDocumentProfile("gpt-5.4-mini"),
  "openai/gpt-5.4-mini-chat": openAIChatProfile("gpt-5.4-mini"),
  "openai/gpt-5.4-nano": openAIDocumentProfile("gpt-5.4-nano"),
  "openai/gpt-5.5": openAIDocumentProfile("gpt-5.5"),
  "openai/gpt-5.6": openAIDocumentProfile("gpt-5.6"),
  "openai/gpt-5.6-sol": openAIDocumentProfile("gpt-5.6-sol"),
  "openai/gpt-5.6-terra": openAIDocumentProfile("gpt-5.6-terra"),
  "openai/gpt-5.6-luna": openAIDocumentProfile("gpt-5.6-luna"),
  "openai/gpt-6-sol": openAIDocumentProfile("gpt-6-sol"),
  "openai/gpt-6-sol-chat": openAIChatProfile("gpt-6-sol"),
  "openai/gpt-6-luna": openAIDocumentProfile("gpt-6-luna"),
  "openai/gpt-6-luna-chat": openAIChatProfile("gpt-6-luna")
});

function validateProfile(profile) {
  const required = ["id", "provider", "model", "maxOutputTokens"];
  for (const key of required) {
    if (profile[key] === undefined || profile[key] === null || profile[key] === "") {
      throw new Error(`Model profile is missing ${key}.`);
    }
  }
  const documentFields = ["pagesPerChunk", "overlapPages", "maxSplitDepth"];
  const hasDocumentGeometry = documentFields.some((key) => profile[key] !== undefined);
  if (hasDocumentGeometry) {
    for (const key of documentFields) {
      if (profile[key] === undefined || profile[key] === null) {
        throw new Error(`Document model profile is missing ${key}.`);
      }
    }
    if (!Number.isInteger(profile.pagesPerChunk) || profile.pagesPerChunk < 1) throw new Error("pagesPerChunk must be a positive integer.");
    if (!Number.isInteger(profile.overlapPages) || profile.overlapPages < 0 || profile.overlapPages >= profile.pagesPerChunk) {
      throw new Error("overlapPages must be a non-negative integer smaller than pagesPerChunk.");
    }
    if (!Number.isInteger(profile.maxSplitDepth) || profile.maxSplitDepth < 0) throw new Error("maxSplitDepth must be a non-negative integer.");
  }
  if (!Number.isInteger(profile.maxOutputTokens) || profile.maxOutputTokens < 1) throw new Error("maxOutputTokens must be a positive integer.");
  if (profile.modelMaxOutputTokens !== undefined) {
    if (!Number.isInteger(profile.modelMaxOutputTokens) || profile.modelMaxOutputTokens < 1) {
      throw new Error("modelMaxOutputTokens must be a positive integer.");
    }
    if (profile.maxOutputTokens > profile.modelMaxOutputTokens) {
      throw new Error("maxOutputTokens cannot exceed modelMaxOutputTokens.");
    }
  }
  if (profile.effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(profile.effort)) {
    throw new Error("effort must be low, medium, high, xhigh, or max.");
  }
  if (profile.thinking !== undefined) {
    if (!profile.thinking || !["adaptive", "disabled"].includes(profile.thinking.type)) {
      throw new Error("thinking.type must be adaptive or disabled.");
    }
    if (
      profile.thinking.display !== undefined &&
      !["summarized", "omitted", "updates"].includes(profile.thinking.display)
    ) {
      throw new Error("thinking.display must be summarized, omitted, or updates.");
    }
    if (profile.thinking.type === "disabled" && profile.thinking.display !== undefined) {
      throw new Error("thinking.display cannot be used when thinking is disabled.");
    }
    const blockBinding = profile.thinking.block_binding;
    if (
      blockBinding !== undefined &&
      (!blockBinding || typeof blockBinding !== "object" || Array.isArray(blockBinding))
    ) {
      throw new Error("thinking.block_binding must be an object.");
    }
    if (
      blockBinding?.prefix_mismatch_behavior !== undefined &&
      !["error", "drop_block"].includes(blockBinding.prefix_mismatch_behavior)
    ) {
      throw new Error("thinking.block_binding.prefix_mismatch_behavior must be error or drop_block.");
    }
    if (profile.thinking.type === "disabled" && blockBinding !== undefined) {
      throw new Error("thinking.block_binding cannot be used when thinking is disabled.");
    }
  }
  if (profile.pdfDetail !== undefined && !["auto", "low", "high"].includes(profile.pdfDetail)) {
    throw new Error("pdfDetail must be auto, low, or high.");
  }
  if (profile.reasoningEffort !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(profile.reasoningEffort)) {
    throw new Error("reasoningEffort must be none, minimal, low, medium, high, xhigh, or max.");
  }
  return Object.freeze({
    ...profile,
    ...(profile.thinking ? {
      thinking: Object.freeze({
        ...profile.thinking,
        ...(profile.thinking.block_binding ? {
          block_binding: Object.freeze({ ...profile.thinking.block_binding })
        } : {})
      })
    } : {})
  });
}

function resolveModelProfile({ provider, model, profiles = {}, profileId = null }) {
  const allProfiles = { ...BUILTIN_MODEL_PROFILES, ...profiles };
  const id = profileId || `${provider}/${model}`;
  const profile = allProfiles[id];
  if (!profile) {
    throw new Error(`No reviewed model profile exists for ${id}. Add an explicit profile before using this model.`);
  }
  const validated = validateProfile(profile);
  if (validated.provider !== provider || validated.model !== model) {
    throw new Error(`Model profile ${id} does not match ${provider}/${model}.`);
  }
  return validated;
}

module.exports = { BUILTIN_MODEL_PROFILES, validateProfile, resolveModelProfile };
