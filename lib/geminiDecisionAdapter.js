const { createDecisionAdapter } = require("./decisionAdapter");

const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => (typeof value === "string" ? value : JSON.stringify(value));
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : undefined);

/**
 * Google's Gemini Decisions API (`POST /v1beta/decisions`). It answers the
 * same three question types with the same answer shapes as the package's
 * decision contract. What differs on the wire: the evaluated content is
 * `input`, a Noul's criteria are `true_description` and `false_description`,
 * usage is reported as totals, and the response does not name the model.
 */
function createGeminiDecisionAdapter({
  apiKey = process.env.GEMINI_API_KEY,
  baseUrl = "https://generativelanguage.googleapis.com/v1beta",
  ...options
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("A Gemini apiKey or GEMINI_API_KEY is required.");
  return createDecisionAdapter({
    ...options,
    provider: "google",
    label: "Gemini",
    apiKey,
    url: `${baseUrl.replace(/\/$/, "")}/decisions`,
    headers: { "x-goog-api-key": apiKey },
    defaultModel: "gemini-decision-1",
    // The service takes text: structured state, instructions and descriptions go as their JSON.
    toWire: ({ model, state, questions }) => ({
      model,
      input: text(state),
      questions: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, {
        ...q,
        instructions: text(q.instructions),
        ...(q.criteria === undefined ? {} : { criteria: q.type === "noul"
          ? {
            ...(q.criteria.true !== undefined ? { true_description: text(q.criteria.true) } : {}),
            ...(q.criteria.false !== undefined ? { false_description: text(q.criteria.false) } : {})
          }
          : Array.isArray(q.criteria) ? q.criteria.map(text)
            : Object.fromEntries(Object.entries(q.criteria).map(([key, value]) => [key, value === null ? null : text(value)])) })
      }]))
    }),
    // Left as received when it isn't the documented shape, so validation reports it.
    fromWire: (body, sent) => (isMap(body) ? {
      ...body,
      model: typeof body.model === "string" && body.model ? body.model : sent.model,
      usage: isMap(body.usage)
        ? { ...body.usage, input_tokens: count(body.usage.total_input_tokens), output_tokens: count(body.usage.total_output_tokens) }
        : body.usage
    } : body)
  });
}

module.exports = { createGeminiDecisionAdapter };
