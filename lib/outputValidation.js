const Ajv = require("ajv");

const ajv = new Ajv({
  allErrors: true,
  allowUnionTypes: true,
  strict: false
});
const validators = new WeakMap();

function validatorFor(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("A JSON Schema object is required to validate provider tool input.");
  }
  if (!validators.has(schema)) validators.set(schema, ajv.compile(schema));
  return validators.get(schema);
}

function validationSummary(errors) {
  return (errors || [])
    .slice(0, 3)
    .map((error) => `${error.instancePath || "/"} [${error.keyword}] ${error.message || "is invalid"}`)
    .join("; ");
}

function toolInputValidationError(toolName, output, schema) {
  const validate = validatorFor(schema);
  if (validate(output)) return null;

  const error = new Error(
    `Provider returned invalid input for output tool "${toolName}": ${validationSummary(validate.errors)}.`
  );
  error.name = "ToolInputValidationError";
  error.code = "TOOL_INPUT_VALIDATION_FAILED";
  return error;
}

module.exports = { toolInputValidationError };
