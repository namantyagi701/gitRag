/**
 * Embedding model loading and text preparation for ingestion
 */

/**
 * Load @xenova/transformers pipeline once
 */
async function loadEmbedder(modelName = "Xenova/all-MiniLM-L6-v2") {
  const { pipeline } = await import("@xenova/transformers");
  const embedder = await pipeline("feature-extraction", modelName);
  return embedder;
}

/**
 * Prepare and cleanly truncate text for symbol embedding (~2000 chars)
 */
function prepareEmbeddingText(symbolName, docstring, codeBody, maxLength = 2000) {
  const combined = `${symbolName}\n${docstring || ""}\n${codeBody}`;
  if (combined.length <= maxLength) {
    return combined;
  }
  let truncated = combined.slice(0, maxLength);
  // Avoid truncating mid-word if whitespace is found in the trailing section
  const lastWhitespace = Math.max(
    truncated.lastIndexOf(" "),
    truncated.lastIndexOf("\n"),
    truncated.lastIndexOf("\t")
  );
  if (lastWhitespace > maxLength * 0.8) {
    truncated = truncated.slice(0, lastWhitespace);
  }
  return truncated;
}

module.exports = {
  loadEmbedder,
  prepareEmbeddingText
};
