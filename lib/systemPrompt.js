function normalizeSystem(system) {
  if (system === null || system === undefined || system === "") return [];
  if (!Array.isArray(system)) return system;
  return system
    .map((block) => typeof block === "string" ? { type: "text", text: block } : block)
    .filter((block) => block && (block.type !== "text" || block.text?.trim()));
}

module.exports = { normalizeSystem };
