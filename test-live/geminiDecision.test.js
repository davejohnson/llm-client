const test = require("node:test");
const assert = require("node:assert/strict");
const { callDecision, createGeminiDecisionAdapter } = require("..");

test("live Gemini Decision returns Choice, Score, and Noul decisions", {
  skip: process.env.LIVE_GEMINI_DECISION !== "1"
}, async () => {
  assert.ok(process.env.GEMINI_API_KEY, "GEMINI_API_KEY is required");
  const result = await callDecision({
    adapter: createGeminiDecisionAdapter(),
    state: "Invoice from Acme for CAD 42.50, due tomorrow.",
    questions: {
      kind: { type: "choice", instructions: "Classify this document", criteria: { invoice: "A bill", other: "Something else" } },
      complete: { type: "score", instructions: "How many invoice fields are present?", criteria: ["None", "Some", "All"] },
      money: { type: "noul", instructions: "Does this document mention money?", criteria: { true: "An amount is stated", false: "No amount is stated" } },
      record: { type: "noul", instructions: "Is this about a bill?" }
    }
  });
  // Validate the real service contract, not deterministic model judgments.
  assert.equal(result.answers.kind.type, "choice");
  assert.equal(result.answers.complete.type, "score");
  assert.equal(result.answers.money.type, "noul");
  assert.ok(result.tokenUsage.inputTokens > 0);
  assert.equal(result.model, "gemini-decision-1");
});

test("live Gemini Decision accepts structured state and instructions, and an option with no description", {
  skip: process.env.LIVE_GEMINI_DECISION !== "1"
}, async () => {
  const result = await callDecision({
    adapter: createGeminiDecisionAdapter(),
    state: { vendor: "Acme", total: 42.5, currency: "CAD" },
    questions: {
      money: { type: "noul", instructions: { question: "Does this record state an amount?" } },
      kind: { type: "choice", instructions: "Classify this record", criteria: { invoice: "A bill", other: null } }
    }
  });
  assert.equal(result.answers.money.type, "noul");
  assert.equal(result.answers.kind.type, "choice");
});
