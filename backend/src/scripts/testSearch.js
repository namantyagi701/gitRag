#!/usr/bin/env node

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const { PrismaClient } = require("@prisma/client");
const { loadEmbedder } = require("../ingestion/embedder");
const { hybridSearch } = require("../services/hybridSearch");

const prisma = new PrismaClient();

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: node src/scripts/testSearch.js <query> <owner> <name>");
    console.error("   or: node src/scripts/testSearch.js <query> <owner/name>");
    console.error("   or: node src/scripts/testSearch.js <query> <repo_id>");
    process.exit(1);
  }

  const query = args[0];
  let owner;
  let name;
  let repoId;

  if (args.length >= 3) {
    owner = args[1];
    name = args[2];
  } else if (!isNaN(parseInt(args[1], 10)) && !args[1].includes("/")) {
    repoId = parseInt(args[1], 10);
  } else if (args[1].includes("/")) {
    [owner, name] = args[1].split("/", 2);
  } else {
    console.error("Error: Please provide both owner and name (e.g. 'namantyagi701 gitRag' or 'namantyagi701/gitRag')");
    process.exit(1);
  }

  return { query, owner, name, repoId };
}

async function main() {
  const { query, owner, name, repoId: rawRepoId } = parseArgs();

  // 1. Resolve repository
  let repoId = rawRepoId;
  let repoName = "";

  if (owner && name) {
    const repo = await prisma.repo.findUnique({
      where: { owner_name: { owner, name } }
    });
    if (!repo) {
      console.error(`Error: Repository '${owner}/${name}' not found in database.`);
      process.exit(1);
    }
    repoId = repo.id;
    repoName = `${owner}/${name}`;
  } else {
    const repo = await prisma.repo.findUnique({
      where: { id: repoId }
    });
    if (!repo) {
      console.error(`Error: Repository with ID ${repoId} not found in database.`);
      process.exit(1);
    }
    repoName = `${repo.owner}/${repo.name}`;
  }

  console.log(`\n========================================`);
  console.log(` GitRAG Hybrid Search`);
  console.log(`========================================`);
  console.log(`Query      : "${query}"`);
  console.log(`Repository : ${repoName} (ID: ${repoId})\n`);

  // 2. Load embedder once
  console.log(`Loading embedding model (Xenova/all-MiniLM-L6-v2)...`);
  const embedder = await loadEmbedder();
  console.log(`Embedding model ready.\n`);

  // 3. Execute hybrid search
  const results = await hybridSearch({
    query,
    repoId,
    embedder,
    prisma,
    textWeight: 0.4,
    vectorWeight: 0.6,
    limit: 25
  });

  if (results.length === 0) {
    console.log(`No matching symbols found.\n`);
    return;
  }

  console.log(`Top ${Math.min(results.length, 10)} Results:`);
  console.log(`----------------------------------------------------------------------------------------------------------------------`);
  console.log(
    `| ${"Rank".padEnd(4)} | ${"Symbol Name".padEnd(30)} | ${"Type".padEnd(10)} | ${"File Path".padEnd(32)} | ${"Text".padEnd(7)} | ${"Vector".padEnd(7)} | ${"Combined".padEnd(8)} |`
  );
  console.log(`----------------------------------------------------------------------------------------------------------------------`);

  results.slice(0, 10).forEach((item, idx) => {
    const rank = String(idx + 1).padEnd(4);
    const symName = (item.symbol_name.length > 30 ? item.symbol_name.slice(0, 27) + "..." : item.symbol_name).padEnd(30);
    const symType = item.symbol_type.padEnd(10);
    const filePath = (item.file_path.length > 32 ? item.file_path.slice(0, 29) + "..." : item.file_path).padEnd(32);
    const textScore = item.text_score.toFixed(3).padStart(7);
    const vectorScore = item.vector_score.toFixed(3).padStart(7);
    const combinedScore = item.combined_score.toFixed(3).padStart(8);

    console.log(`| ${rank} | ${symName} | ${symType} | ${filePath} | ${textScore} | ${vectorScore} | ${combinedScore} |`);
  });

  console.log(`----------------------------------------------------------------------------------------------------------------------\n`);
}

main()
  .catch((err) => {
    console.error("Search failed with error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
