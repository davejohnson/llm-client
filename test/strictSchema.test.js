const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeStrictSchema, restoreOptionalProperties } = require("..");

test("strict schema normalization requires nested fields and makes optional fields nullable", () => {
  const schema = {
    type: "object",
    properties: {
      id: { type: "string" },
      metadata: {
        type: "object",
        properties: {
          source: { type: "string" },
          confidence: { type: "number" }
        },
        required: ["source"],
        additionalProperties: false
      },
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            note: { type: "string" }
          },
          required: ["label"],
          additionalProperties: false
        }
      }
    },
    required: ["id", "rows"],
    additionalProperties: false
  };

  const normalized = normalizeStrictSchema(schema);

  assert.deepEqual(normalized.required, ["id", "metadata", "rows"]);
  assert.deepEqual(normalized.properties.metadata.type, ["object", "null"]);
  assert.deepEqual(normalized.properties.metadata.required, ["source", "confidence"]);
  assert.deepEqual(normalized.properties.metadata.properties.confidence.type, ["number", "null"]);
  assert.equal(normalized.properties.metadata.additionalProperties, false);
  assert.deepEqual(normalized.properties.rows.items.required, ["label", "note"]);
  assert.deepEqual(normalized.properties.rows.items.properties.note.type, ["string", "null"]);
  assert.equal(normalized.properties.rows.items.additionalProperties, false);
  assert.equal(normalized.additionalProperties, false);
  assert.deepEqual(schema.required, ["id", "rows"]);
  assert.equal(schema.properties.metadata.properties.confidence.type, "number");
});

test("optional properties added for OpenAI strict mode are omitted from tool inputs again", () => {
  const schema = {
    type: "object",
    properties: {
      query: { type: "string" },
      optionalFilter: { type: "string" },
      nullableFilter: { type: ["string", "null"] },
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            note: { type: "string" }
          },
          required: ["id"],
          additionalProperties: false
        }
      }
    },
    required: ["query", "rows"],
    additionalProperties: false
  };

  assert.deepEqual(restoreOptionalProperties({
    query: "roof",
    optionalFilter: null,
    nullableFilter: null,
    rows: [{ id: "1", note: null }]
  }, schema), {
    query: "roof",
    nullableFilter: null,
    rows: [{ id: "1" }]
  });
});
