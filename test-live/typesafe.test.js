const test = require("node:test");
const assert = require("node:assert/strict");
const { callDecision, createTypeSafeAdapter } = require("..");

test("live Jev returns Choice, Score, and Noul decisions", {
  skip: process.env.LIVE_TYPESAFE_DECISION !== "1"
}, async () => {
  assert.ok(process.env.TYPESAFE_API_KEY, "TYPESAFE_API_KEY is required");
  const result = await callDecision({
    adapter: createTypeSafeAdapter(),
    state: "Invoice from Acme for CAD 42.50, due tomorrow.",
    questions: {
      kind: { type: "choice", instructions: "Classify this document", criteria: { invoice: "A bill", other: "Something else" } },
      complete: { type: "score", instructions: "How many invoice fields are present?", criteria: ["None", "Some", "All"] },
      money: { type: "noul", instructions: "Does this document mention money?" }
    }
  });
  // Validate the real service contract, not deterministic model judgments.
  assert.equal(result.answers.kind.type, "choice");
  assert.equal(result.answers.complete.type, "score");
  assert.equal(result.answers.money.type, "noul");
  assert.ok(result.tokenUsage.inputTokens > 0);
  assert.ok(result.model);
});
