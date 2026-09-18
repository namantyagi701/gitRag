/**
 * Hybrid search service combining full-text keyword search and pgvector similarity.
 */

/**
 * Perform hybrid search over symbols table using ts_rank and cosine similarity.
 *
 * @param {Object} params
 * @param {string} params.query - Search query string
 * @param {number} params.repoId - Repository ID to filter symbols
 * @param {Function} params.embedder - Embedding pipeline instance (@xenova/transformers)
 * @param {Object} params.prisma - PrismaClient instance
 * @param {number} [params.textWeight=0.4] - Weight for keyword/full-text score
 * @param {number} [params.vectorWeight=0.6] - Weight for vector similarity score
 * @param {number} [params.limit=25] - Maximum number of results to return
 * @param {number} [params.minScore=0.3] - Minimum combined score threshold
 * @returns {Promise<Array<Object>>} Ranked search results
 */
async function hybridSearch({
  query,
  repoId,
  embedder,
  prisma,
  textWeight = 0.4,
  vectorWeight = 0.6,
  limit = 25,
  minScore = 0.3
}) {
  if (!query || typeof query !== "string" || !query.trim()) {
    return [];
  }

  // 1. Generate query embedding using the passed embedder
  const output = await embedder(query, { pooling: "mean", normalize: true });
  const queryEmbedding = Array.from(output.data);
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;

  // 2. Execute hybrid search raw query with CTE and threshold filter
  const rows = await prisma.$queryRaw`
    WITH scored AS (
      SELECT 
        s.id AS symbol_id,
        s.symbol_name,
        s.symbol_type,
        f.file_path,
        s.code_body,
        COALESCE(ts_rank(s.search_vector, plainto_tsquery('english', ${query})), 0)::float AS text_score,
        (1 - (s.embedding <=> ${vectorLiteral}::vector))::float AS vector_score
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.repo_id = ${repoId} AND s.embedding IS NOT NULL
    )
    SELECT *,
      (text_score * ${textWeight} + vector_score * ${vectorWeight})::float AS combined_score
    FROM scored
    WHERE (text_score * ${textWeight} + vector_score * ${vectorWeight}) >= ${minScore}
    ORDER BY combined_score DESC
    LIMIT ${limit}
  `;

  // Format and clamp minor precision anomalies (< 1e-5 to 0 for text_score)
  return rows.map((row) => {
    const rawText = Number(row.text_score);
    const textScore = rawText < 1e-5 ? 0 : rawText;
    const vectorScore = Number(row.vector_score);
    const combinedScore = Number(row.combined_score);

    return {
      symbol_id: row.symbol_id,
      symbol_name: row.symbol_name,
      symbol_type: row.symbol_type,
      file_path: row.file_path,
      code_body: row.code_body,
      text_score: textScore,
      vector_score: vectorScore,
      combined_score: combinedScore
    };
  });
}

module.exports = {
  hybridSearch
};
