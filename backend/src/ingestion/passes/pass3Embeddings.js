const { prepareEmbeddingText } = require("../embedder");

/**
 * PASS 3: Embedding Generation (symbols.embedding)
 */
async function runPass3EmbeddingGeneration({ repo, embedder, prisma }) {
  console.log(`\n[Pass 3] Generating symbol vector embeddings (all-MiniLM-L6-v2)...`);

  // Query all symbols in this repo that lack embeddings (new or updated)
  const pendingSymbols = await prisma.$queryRaw`
    SELECT s.id, s.symbol_name, s.docstring, s.code_body, f.file_path
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.repo_id = ${repo.id} AND s.embedding IS NULL
    ORDER BY s.id ASC
  `;

  // Count symbols that already have non-null embeddings (reused/unchanged)
  const [{ count: embeddingsReusedCount }] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS count
    FROM symbols
    WHERE repo_id = ${repo.id} AND embedding IS NOT NULL
  `;

  let embeddingsGeneratedCount = 0;
  const BATCH_SIZE = 20;

  if (pendingSymbols.length > 0) {
    console.log(`      Found ${pendingSymbols.length} symbol(s) needing embeddings. Processing in batches of ${BATCH_SIZE}...`);

    for (let i = 0; i < pendingSymbols.length; i += BATCH_SIZE) {
      const batch = pendingSymbols.slice(i, i + BATCH_SIZE);
      const batchTexts = batch.map((sym) =>
        prepareEmbeddingText(sym.symbol_name, sym.docstring, sym.code_body)
      );

      try {
        const output = await embedder(batchTexts, { pooling: "mean", normalize: true });
        const dim = 384;

        for (let j = 0; j < batch.length; j++) {
          const sym = batch[j];
          try {
            const rawVector = output.data.slice(j * dim, (j + 1) * dim);
            const embeddingArray = Array.from(rawVector);
            const vectorLiteral = `[${embeddingArray.join(",")}]`;

            await prisma.$executeRaw`
              UPDATE symbols
              SET embedding = ${vectorLiteral}::vector
              WHERE id = ${sym.id}
            `;
            embeddingsGeneratedCount++;
          } catch (writeErr) {
            console.warn(`      [WARN] Failed to write embedding for symbol '${sym.symbol_name}' in '${sym.file_path}': ${writeErr.message}`);
          }
        }
      } catch (batchErr) {
        // Fallback to per-symbol embedding if batch call fails
        for (let j = 0; j < batch.length; j++) {
          const sym = batch[j];
          try {
            const text = batchTexts[j];
            const singleOutput = await embedder(text, { pooling: "mean", normalize: true });
            const embeddingArray = Array.from(singleOutput.data);
            const vectorLiteral = `[${embeddingArray.join(",")}]`;

            await prisma.$executeRaw`
              UPDATE symbols
              SET embedding = ${vectorLiteral}::vector
              WHERE id = ${sym.id}
            `;
            embeddingsGeneratedCount++;
          } catch (itemErr) {
            console.warn(`      [WARN] Failed to generate embedding for symbol '${sym.symbol_name}' in '${sym.file_path}': ${itemErr.message}`);
          }
        }
      }
    }
  } else {
    console.log(`      All symbols already have embeddings. 0 new embeddings needed.`);
  }

  return {
    embeddingsGeneratedCount,
    embeddingsReusedCount
  };
}

module.exports = {
  runPass3EmbeddingGeneration
};
