const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const isContent = (value) => typeof value === "string" || isMap(value) || Array.isArray(value);
const probability = (value) => Number.isFinite(value) && value >= 0 && value <= 1;

function assertJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || Number.isFinite(value)) return;
  if ((!isMap(value) && !Array.isArray(value)) || ancestors.has(value)) throw new Error("Decision input must contain only JSON values without cycles.");
  ancestors.add(value);
  for (const item of Object.values(value)) assertJson(item, ancestors);
  ancestors.delete(value);
}

function validateDecisionRequest({ model, state, questions }) {
  if (typeof model !== "string" || !model.trim()) throw new Error("A decision model is required.");
  if (!isContent(state)) throw new Error("state must be a string, JSON object, or array.");
  if (!isMap(questions) || !Object.keys(questions).length) throw new Error("questions must be a non-empty map.");
  assertJson({ state, questions });
  for (const [id, q] of Object.entries(questions)) {
    if (!isMap(q) || !isContent(q.instructions)) throw new Error(`Question ${id} requires instructions.`);
    const criteria = q.criteria;
    if (q.type === "choice") {
      if (!isMap(criteria) || Object.keys(criteria).length < 1 || Object.keys(criteria).length > 255
        || !Object.values(criteria).every((v) => v === null || isContent(v))) {
        throw new Error(`Choice ${id} requires 1–255 criteria with text, structured, or null descriptions.`);
      }
    } else if (q.type === "score") {
      if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10 || !criteria.every(isContent)) {
        throw new Error(`Score ${id} requires 2–10 criteria.`);
      }
    } else if (q.type === "noul") {
      if (criteria !== undefined && (!isMap(criteria) || !Object.entries(criteria).every(([key, value]) => ["true", "false"].includes(key) && isContent(value)))) {
        throw new Error(`Noul ${id} criteria may describe true and false.`);
      }
    } else throw new Error(`Unknown decision question type for ${id}.`);
  }
}

function validateDecisionResponse(body, questions) {
  function requireValue(condition, detail) {
    if (!condition) {
      const error = new Error(`Invalid TypeSafe response: ${detail}.`);
      error.name = "DecisionResponseError";
      throw error;
    }
  }
  requireValue(isMap(body) && typeof body.model === "string" && body.model.length > 0 && isMap(body.answers), "model and answers are required");
  requireValue(isMap(body.usage) && [body.usage.input_tokens, body.usage.output_tokens].every((v) => Number.isInteger(v) && v >= 0), "invalid token usage");
  requireValue(Object.keys(body.answers).length === Object.keys(questions).length, "answer count does not match questions");
  for (const [id, q] of Object.entries(questions)) {
    const a = Object.hasOwn(body.answers, id) ? body.answers[id] : null;
    requireValue(isMap(a) && a.type === q.type, `missing or mismatched answer ${id}`);
    if (q.type === "noul") {
      requireValue(probability(a.noul), `invalid noul ${id}`);
      continue;
    }
    const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    requireValue(probability(a.confidence), `invalid confidence ${id}`);
    requireValue(isMap(a.probabilities) && Object.keys(a.probabilities).length === keys.length
      && keys.every((key) => Object.hasOwn(a.probabilities, key) && probability(a.probabilities[key])), `invalid probabilities ${id}`);
    // Allow rounding of serialized probabilities while rejecting broken distributions.
    requireValue(Math.abs(Object.values(a.probabilities).reduce((sum, p) => sum + p, 0) - 1) <= 0.001, `probabilities do not sum to one for ${id}`);
    if (q.type === "choice") requireValue(typeof a.choice === "string" && keys.includes(a.choice), `unknown choice ${id}`);
    else {
      requireValue(Number.isFinite(a.score) && a.score >= 0 && a.score <= keys.length - 1, `invalid score ${id}`);
      requireValue(isMap(a.legend) && Object.keys(a.legend).length === keys.length && keys.every((key) => Object.hasOwn(a.legend, key)), `invalid legend ${id}`);
    }
  }
}

module.exports = { validateDecisionRequest, validateDecisionResponse };
