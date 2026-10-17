function acceptsNull(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  if (schema.type === "null") return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  if (schema.const === null) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
  return ["anyOf", "oneOf"].some((key) => (
    Array.isArray(schema[key]) && schema[key].some(acceptsNull)
  ));
}

function makeNullable(schema) {
  if (acceptsNull(schema)) return schema;
  if (Object.prototype.hasOwnProperty.call(schema, "const")) {
    return { anyOf: [schema, { type: "null" }] };
  }

  const nullable = { ...schema };
  if (Array.isArray(nullable.enum)) nullable.enum = [...nullable.enum, null];
  if (typeof nullable.type === "string") nullable.type = [nullable.type, "null"];
  else if (Array.isArray(nullable.type)) nullable.type = [...nullable.type, "null"];
  else if (Array.isArray(nullable.enum)) return nullable;
  else if (Array.isArray(nullable.anyOf)) nullable.anyOf = [...nullable.anyOf, { type: "null" }];
  else if (Array.isArray(nullable.oneOf)) nullable.oneOf = [...nullable.oneOf, { type: "null" }];
  else return { anyOf: [schema, { type: "null" }] };
  return nullable;
}

function normalizeSchemaMap(schemaMap) {
  if (!schemaMap || typeof schemaMap !== "object" || Array.isArray(schemaMap)) return schemaMap;
  return Object.fromEntries(
    Object.entries(schemaMap).map(([key, schema]) => [key, normalizeStrictSchema(schema)])
  );
}

function normalizeStrictSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;

  const normalized = { ...schema };
  for (const key of ["items", "contains", "additionalProperties", "unevaluatedProperties", "propertyNames", "not", "if", "then", "else"]) {
    if (Array.isArray(schema[key])) {
      normalized[key] = schema[key].map(normalizeStrictSchema);
    } else if (schema[key] && typeof schema[key] === "object") {
      normalized[key] = normalizeStrictSchema(schema[key]);
    }
  }
  for (const key of ["prefixItems", "allOf", "anyOf", "oneOf"]) {
    if (Array.isArray(schema[key])) {
      normalized[key] = schema[key].map(normalizeStrictSchema);
    }
  }
  for (const key of ["$defs", "definitions", "patternProperties", "dependentSchemas"]) {
    if (schema[key]) normalized[key] = normalizeSchemaMap(schema[key]);
  }

  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    const originallyRequired = new Set(Array.isArray(schema.required) ? schema.required : []);
    normalized.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, propertySchema]) => {
        const property = normalizeStrictSchema(propertySchema);
        return [key, originallyRequired.has(key) ? property : makeNullable(property)];
      })
    );
    normalized.required = Object.keys(schema.properties);
  }

  return normalized;
}

function restoreOptionalProperties(value, schema) {
  if (value === null || value === undefined || !schema || typeof schema !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => restoreOptionalProperties(item, schema.items));
  }
  if (typeof value !== "object" || Array.isArray(schema.properties)) return value;
  if (!schema.properties || typeof schema.properties !== "object") return value;

  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, propertyValue]) => {
      const propertySchema = schema.properties[key];
      if (!propertySchema) return [[key, propertyValue]];
      if (propertyValue === null && !required.has(key) && !acceptsNull(propertySchema)) return [];
      return [[key, restoreOptionalProperties(propertyValue, propertySchema)]];
    })
  );
}

module.exports = { normalizeStrictSchema, restoreOptionalProperties };
