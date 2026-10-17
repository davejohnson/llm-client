function mediaTypeForDocument(block) {
  return block.mediaType || block.source?.media_type || null;
}

// Document callers keep text chunks provider-neutral by carrying UTF-8 bytes
// in dataBase64. Adapters decode those bytes into each provider's native text
// representation; an already-normalized text source remains supported for
// compatibility with existing callers.
function textForDocument(block) {
  if (block?.type !== "document") return null;
  if (block.source?.type === "text") return String(block.source.data ?? "");
  if (mediaTypeForDocument(block) !== "text/plain") return null;
  const dataBase64 = block.dataBase64 ?? block.source?.data;
  if (typeof dataBase64 !== "string") {
    throw new Error("Plain-text document blocks require source text or base64-encoded UTF-8 data.");
  }
  return Buffer.from(dataBase64, "base64").toString("utf8");
}

module.exports = { mediaTypeForDocument, textForDocument };
