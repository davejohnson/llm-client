const pdf = require("./lib/pdfChunks");
const profiles = require("./lib/modelProfiles");
const strictSchema = require("./lib/strictSchema");
const priceCatalog = require("./lib/priceCatalog");
const {
  isProviderCreditError,
  normalizeProviderFailure,
  providerErrorInfo
} = require("./lib/providerErrors");
const { createAnthropicAdapter } = require("./lib/anthropicAdapter");
const { createOpenAIAdapter } = require("./lib/openaiAdapter");
const { createMetaAdapter } = require("./lib/metaAdapter");
const { callChatTurn, callText, normalizeSystem, streamChatTurn } = require("./lib/chatTurn");
const { callStructured } = require("./lib/structuredCall");
const { createTypeSafeAdapter } = require("./lib/typesafeAdapter");
const { BUILTIN_DECISION_PROFILES, callDecision } = require("./lib/decisionCall");

module.exports = {
  BUILTIN_DECISION_PROFILES,
  callDecision,
  createTypeSafeAdapter,
  ...pdf,
  ...profiles,
  ...strictSchema,
  ...priceCatalog,
  isProviderCreditError,
  normalizeProviderFailure,
  providerErrorInfo,
  createAnthropicAdapter,
  createMetaAdapter,
  createOpenAIAdapter,
  callChatTurn,
  callText,
  normalizeSystem,
  streamChatTurn,
  callStructured
};
