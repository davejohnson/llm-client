const test = require("node:test");
const assert = require("node:assert/strict");
const { BUILTIN_MODEL_PROFILES, pageRanges, resolveModelProfile } = require("..");

test("PDF chunking preserves the documented default bounds", () => {
  assert.deepEqual(pageRanges(31), [
    { startPage: 1, endPage: 30, overlapPages: 0 },
    { startPage: 28, endPage: 31, overlapPages: 3 }
  ]);
});

test("known model profiles select provider-specific chunk sizes", () => {
  const claude = resolveModelProfile({ provider: "anthropic", model: "claude-opus-4-8" });
  const denseClaude = resolveModelProfile({
    provider: "anthropic",
    model: "claude-opus-4-8",
    profileId: "anthropic/claude-opus-4-8-dense"
  });
  const opus5 = resolveModelProfile({ provider: "anthropic", model: "claude-opus-5" });
  const fable51 = resolveModelProfile({ provider: "anthropic", model: "claude-fable-5-1" });
  const mythos51 = resolveModelProfile({ provider: "anthropic", model: "claude-mythos-5-1" });
  const sonnet = resolveModelProfile({ provider: "anthropic", model: "claude-sonnet-5" });
  const sonnetChat = resolveModelProfile({
    provider: "anthropic",
    model: "claude-sonnet-5",
    profileId: "anthropic/claude-sonnet-5-chat"
  });
  const haiku = resolveModelProfile({ provider: "anthropic", model: "claude-haiku-4-5" });
  const openai = resolveModelProfile({ provider: "openai", model: "gpt-5.4-mini" });
  const meta = resolveModelProfile({ provider: "meta", model: "muse-spark-1.3" });
  assert.equal(claude.pagesPerChunk, 30);
  assert.equal(claude.effort, "medium");
  assert.deepEqual(claude.thinking, { type: "disabled" });
  assert.equal(denseClaude.pagesPerChunk, 12);
  assert.equal(denseClaude.overlapPages, 3);
  assert.equal(denseClaude.maxOutputTokens, 16000);
  assert.equal(denseClaude.maxSplitDepth, 3);
  assert.equal(denseClaude.model, "claude-opus-4-8");
  assert.equal(opus5.pagesPerChunk, 30);
  assert.equal(opus5.overlapPages, 3);
  assert.equal(opus5.maxOutputTokens, 16000);
  assert.equal(opus5.maxSplitDepth, 3);
  assert.equal(opus5.effort, "high");
  assert.deepEqual(opus5.thinking, { type: "adaptive" });
  assert.equal(fable51.pagesPerChunk, 30);
  assert.equal(fable51.maxOutputTokens, 16000);
  assert.equal(fable51.modelMaxOutputTokens, 128000);
  assert.equal(fable51.effort, "high");
  assert.deepEqual(fable51.thinking, { type: "adaptive" });
  assert.equal(mythos51.pagesPerChunk, 30);
  assert.equal(mythos51.modelMaxOutputTokens, 128000);
  assert.deepEqual(mythos51.thinking, { type: "adaptive" });
  assert.equal(sonnet.pagesPerChunk, 24);
  assert.deepEqual(sonnet.thinking, { type: "disabled" });
  assert.equal(sonnetChat.pagesPerChunk, undefined);
  assert.equal(sonnetChat.effort, "medium");
  assert.deepEqual(sonnetChat.thinking, { type: "adaptive" });
  assert.equal(haiku.pagesPerChunk, undefined);
  assert.equal(haiku.maxOutputTokens, 16000);
  assert.equal(openai.pagesPerChunk, 20);
  assert.equal(openai.maxOutputTokens, 12000);
  assert.equal(openai.modelMaxOutputTokens, 128000);
  assert.equal(openai.pdfDetail, "low");
  assert.equal(openai.reasoningEffort, "none");
  assert.equal(meta.pagesPerChunk, 20);
  assert.equal(meta.overlapPages, 2);
  assert.equal(meta.maxOutputTokens, 12000);
  assert.equal(meta.modelMaxOutputTokens, 131072);
  assert.equal(meta.pdfDetail, "low");
  assert.equal(meta.reasoningEffort, "high");
  assert.throws(() => resolveModelProfile({ provider: "anthropic", model: "claude-sonnet-4-5" }), /No reviewed model profile/);
});

test("reviewed OpenAI profiles use the conservative document extraction geometry and budget", () => {
  const models = [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.5",
    "gpt-5.6",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna"
  ];
  for (const model of models) {
    const profile = resolveModelProfile({ provider: "openai", model });
    assert.equal(profile.pagesPerChunk, 20);
    assert.equal(profile.overlapPages, 2);
    assert.equal(profile.maxOutputTokens, 12000);
    assert.equal(profile.modelMaxOutputTokens, 128000);
    assert.equal(profile.pdfDetail, "low");
    assert.equal(profile.reasoningEffort, "none");
  }
});

test("every reviewed output budget stays within its model limit", () => {
  for (const profile of Object.values(BUILTIN_MODEL_PROFILES)) {
    assert.ok(profile.maxOutputTokens <= profile.modelMaxOutputTokens, profile.id);
  }
});

test("unknown models must have an explicit reviewed profile", () => {
  assert.throws(() => resolveModelProfile({ provider: "openai", model: "future-model" }), /No reviewed model profile/);
});

test("provider-specific profile controls are validated", () => {
  const base = {
    id: "anthropic/custom",
    provider: "anthropic",
    model: "custom",
    pagesPerChunk: 10,
    overlapPages: 1,
    maxOutputTokens: 1000,
    maxSplitDepth: 1
  };
  assert.throws(() => resolveModelProfile({
    provider: "anthropic",
    model: "custom",
    profiles: { "anthropic/custom": { ...base, effort: "extreme" } }
  }), /effort/);
  assert.throws(() => resolveModelProfile({
    provider: "anthropic",
    model: "custom",
    profiles: { "anthropic/custom": { ...base, thinking: { type: "manual" } } }
  }), /thinking/);
  assert.throws(() => resolveModelProfile({
    provider: "anthropic",
    model: "custom",
    profiles: { "anthropic/custom": { ...base, thinking: { type: "adaptive", display: "raw" } } }
  }), /thinking\.display/);
  assert.throws(() => resolveModelProfile({
    provider: "anthropic",
    model: "custom",
    profiles: { "anthropic/custom": { ...base, thinking: { type: "disabled", display: "omitted" } } }
  }), /thinking\.display/);
  assert.throws(() => resolveModelProfile({
    provider: "anthropic",
    model: "custom",
    profiles: {
      "anthropic/custom": {
        ...base,
        thinking: {
          type: "adaptive",
          block_binding: { prefix_mismatch_behavior: "ignore" }
        }
      }
    }
  }), /prefix_mismatch_behavior/);
  assert.throws(() => resolveModelProfile({
    provider: "anthropic",
    model: "custom",
    profiles: { "anthropic/custom": { ...base, modelMaxOutputTokens: 999 } }
  }), /modelMaxOutputTokens/);
  assert.equal(resolveModelProfile({
    provider: "meta",
    model: "custom",
    profiles: {
      "meta/custom": {
        id: "meta/custom",
        provider: "meta",
        model: "custom",
        maxOutputTokens: 1000,
        reasoningEffort: "minimal"
      }
    }
  }).reasoningEffort, "minimal");
});

test("generic profiles do not require document chunk geometry", () => {
  const profile = resolveModelProfile({
    provider: "anthropic",
    model: "custom-chat-model",
    profiles: {
      "anthropic/custom-chat-model": {
        id: "anthropic/custom-chat-model",
        provider: "anthropic",
        model: "custom-chat-model",
        maxOutputTokens: 2048,
        modelMaxOutputTokens: 8192
      }
    }
  });

  assert.equal(profile.pagesPerChunk, undefined);
  assert.equal(profile.maxOutputTokens, 2048);
});
