#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const { PrismaClient } = require("@prisma/client");

const { collectCodeFiles } = require("../ingestion/fileScanner");
const { loadEmbedder } = require("../ingestion/embedder");
const { runPass1FileIngestion } = require("../ingestion/passes/pass1Symbols");
const { runPass2EdgeExtraction } = require("../ingestion/passes/pass2Edges");
const { runPass3EmbeddingGeneration } = require("../ingestion/passes/pass3Embeddings");

const prisma = new PrismaClient();

/**
 * Parse CLI arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: node src/scripts/ingest.js <path-to-repo> <owner> <name>");
    console.error("   or: node src/scripts/ingest.js <path-to-repo> <owner/name>");
    process.exit(1);
  }

  const repoPath = path.resolve(process.cwd(), args[0]);

  let owner;
  let name;

  if (args.length >= 3) {
    owner = args[1];
    name = args[2];
  } else if (args[1].includes("/")) {
    [owner, name] = args[1].split("/", 2);
  } else {
    console.error("Error: Please provide both owner and name (e.g., 'facebook' 'react' or 'facebook/react')");
    process.exit(1);
  }

  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    console.error(`Error: Repository path does not exist or is not a directory: ${repoPath}`);
    process.exit(1);
  }

  return { repoPath, owner, name };
}

async function main() {
  const { repoPath, owner, name } = parseArgs();

  console.log(`\n========================================`);
  console.log(` GitRAG Ingestion Pipeline`);
  console.log(`========================================`);
  console.log(`Repo Path : ${repoPath}`);
  console.log(`Owner     : ${owner}`);
  console.log(`Name      : ${name}\n`);

  // Load embedding model once near the top of main() before Pass 1 starts
  console.log(`Loading embedding model (Xenova/all-MiniLM-L6-v2)...`);
  const embedder = await loadEmbedder();
  console.log(`Embedding model loaded successfully.\n`);

  // 1. Find or create repository row
  console.log(`[1/3] Resolving repository '${owner}/${name}' in database...`);
  const repo = await prisma.repo.upsert({
    where: {
      owner_name: { owner, name }
    },
    update: {},
    create: {
      owner,
      name,
      default_branch: "main"
    }
  });

  console.log(`      Repo ID: ${repo.id}`);

  // 2. Discover code files
  console.log(`[2/3] Scanning files (skipping ignored folders & non-code extensions)...`);
  const files = collectCodeFiles(repoPath, repoPath);
  console.log(`      Found ${files.length} code file(s) eligible for ingestion.`);

  // Clean up any files in database that were deleted from disk
  const existingDbFiles = await prisma.file.findMany({
    where: { repo_id: repo.id },
    select: { id: true, file_path: true }
  });
  const currentRelPaths = new Set(files.map((f) => f.relPath));
  const filesToDelete = existingDbFiles.filter((f) => !currentRelPaths.has(f.file_path));

  if (filesToDelete.length > 0) {
    await prisma.file.deleteMany({
      where: { id: { in: filesToDelete.map((f) => f.id) } }
    });
    console.log(`      Pruned ${filesToDelete.length} stale/deleted file(s) from database.`);
  }

  // ==========================================================
  // PASS 1: File Ingestion & Symbol Extraction
  // ==========================================================
  const pass1Stats = await runPass1FileIngestion({ repo, files, prisma });

  // ==========================================================
  // PASS 2: Dependency Graph Edge Extraction (symbol_edges)
  // ==========================================================
  const pass2Stats = await runPass2EdgeExtraction({ repo, files, prisma });

  // ==========================================================
  // PASS 3: Embedding Generation (symbols.embedding)
  // ==========================================================
  const pass3Stats = await runPass3EmbeddingGeneration({ repo, embedder, prisma });

  // Summary Report
  console.log(`\n========================================`);
  console.log(` Ingestion Complete`);
  console.log(`========================================`);
  console.log(`Files Scanned                  : ${pass1Stats.filesScanned}`);
  console.log(`Files Processed (New)          : ${pass1Stats.filesProcessed}`);
  console.log(`Files Skipped (Cached)         : ${pass1Stats.filesSkipped}`);
  console.log(`Files Skipped (No Symbols)     : ${pass1Stats.filesNoSymbols}`);
  console.log(`Symbols Inserted               : ${pass1Stats.symbolsInserted}`);
  if (pass1Stats.symbolsInserted > 0) {
    console.log(`  - Functions                  : ${pass1Stats.symbolsByType.function}`);
    console.log(`  - Classes                    : ${pass1Stats.symbolsByType.class}`);
    console.log(`  - Methods                    : ${pass1Stats.symbolsByType.method}`);
  }
  console.log(`Edges Extracted (total)        : ${pass2Stats.totalEdgesCount}`);
  console.log(`Embeddings Generated (total)   : ${pass3Stats.embeddingsGeneratedCount}`);
  console.log(`Embeddings Reused (unchanged)  : ${pass3Stats.embeddingsReusedCount}`);
  console.log(`========================================\n`);
}

main()
  .catch((err) => {
    console.error("\n[FATAL ERROR during ingestion]:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
