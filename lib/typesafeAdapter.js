const { createDecisionAdapter } = require("./decisionAdapter");

function createTypeSafeAdapter({
  apiKey = process.env.TYPESAFE_API_KEY,
  baseUrl = "https://api.typesafe.ai/v1",
  ...options
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("A TypeSafe apiKey or TYPESAFE_API_KEY is required.");
  return createDecisionAdapter({
    ...options,
    provider: "typesafe",
    label: "TypeSafe",
    apiKey,
    url: `${baseUrl.replace(/\/$/, "")}/systemone`,
    headers: { Authorization: `Bearer ${apiKey}` },
    defaultModel: "jev-1.13.0"
  });
}

module.exports = { createTypeSafeAdapter };
