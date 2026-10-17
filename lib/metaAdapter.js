const { createResponsesAdapter } = require("./openaiAdapter");

function createMetaAdapter(options = {}) {
  return createResponsesAdapter(options, {
    provider: "meta",
    providerLabel: "Meta",
    defaultBaseUrl: "https://api.meta.ai/v1",
    structuredOutputMode: "json_schema",
    automaticToolChoiceOnly: true,
    allowDeveloperMessages: true,
    includeEncryptedReasoning: true
  });
}

module.exports = { createMetaAdapter };
