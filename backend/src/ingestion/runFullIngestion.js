const { collectCodeFiles } = require("./fileScanner");
const { runPass1FileIngestion } = require("./passes/pass1Symbols");
const { runPass2EdgeExtraction } = require("./passes/pass2Edges");
const { runPass3EmbeddingGeneration } = require("./passes/pass3Embeddings");
const defaultPrisma = require("../db/prisma");

/**
 * Orchestrates Pass 1, Pass 2, and Pass 3 full repository code ingestion.
 *
 * @param {Object} params
 * @param {string} params.repoPath - Local filesystem path to repository
 * @param {number} params.repoId - Database ID of repository
 * @param {Object} params.embedder - Initialized Xenova feature extraction pipeline
 * @param {Object} [params.prisma] - Optional PrismaClient instance
 * @returns {Promise<{ pass1Stats: Object, pass2Stats: Object, pass3Stats: Object }>}
 */
async function runFullIngestion({ repoPath, repoId, embedder, prisma = defaultPrisma }) {
  const repo = await prisma.repo.findUnique({
    where: { id: repoId },
  });

  if (!repo) {
    throw new Error(`[runFullIngestion] Repository with ID ${repoId} not found in database`);
  }

  console.log(`[runFullIngestion] Scanning code files at: ${repoPath}...`);
  const files = collectCodeFiles(repoPath, repoPath);
  console.log(`[runFullIngestion] Found ${files.length} code file(s) eligible for ingestion.`);

  // Clean up any files in database that were deleted from disk
  const existingDbFiles = await prisma.file.findMany({
    where: { repo_id: repo.id },
    select: { id: true, file_path: true },
  });
  const currentRelPaths = new Set(files.map((f) => f.relPath));
  const filesToDelete = existingDbFiles.filter((f) => !currentRelPaths.has(f.file_path));

  if (filesToDelete.length > 0) {
    await prisma.file.deleteMany({
      where: { id: { in: filesToDelete.map((f) => f.id) } },
    });
    console.log(`[runFullIngestion] Pruned ${filesToDelete.length} stale/deleted file(s) from database.`);
  }

  // Pass 1: File Ingestion & Symbol Extraction
  console.log(`[runFullIngestion] Running Pass 1 (Symbol Extraction)...`);
  const pass1Stats = await runPass1FileIngestion({ repo, files, prisma });

  // Pass 2: Dependency Graph Edge Extraction (symbol_edges)
  console.log(`[runFullIngestion] Running Pass 2 (Edge Extraction)...`);
  const pass2Stats = await runPass2EdgeExtraction({ repo, files, prisma });

  // Pass 3: Embedding Generation (symbols.embedding)
  console.log(`[runFullIngestion] Running Pass 3 (Embedding Generation)...`);
  const pass3Stats = await runPass3EmbeddingGeneration({ repo, embedder, prisma });

  console.log(`[runFullIngestion] Ingestion finished for repo ${repo.owner}/${repo.name} (ID: ${repo.id}).`);

  return {
    pass1Stats,
    pass2Stats,
    pass3Stats,
  };
}

module.exports = {
  runFullIngestion,
};
