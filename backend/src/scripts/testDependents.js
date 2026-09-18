#!/usr/bin/env node

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const { PrismaClient } = require("@prisma/client");
const { findDependents, findDependencies } = require("../services/dependencyGraph");

const prisma = new PrismaClient();

function parseArgs() {
  const rawArgs = process.argv.slice(2);
  let maxDepth = 2;
  const filteredArgs = [];

  for (const arg of rawArgs) {
    if (arg.startsWith("--maxDepth=")) {
      const val = parseInt(arg.split("=")[1], 10);
      if (!isNaN(val)) {
        maxDepth = val;
      }
    } else {
      filteredArgs.push(arg);
    }
  }

  if (filteredArgs.length < 2) {
    console.error("Usage: node src/scripts/testDependents.js <symbol_name> <owner> <name> [--maxDepth=X]");
    console.error("   or: node src/scripts/testDependents.js <symbol_name> <owner/name> [--maxDepth=X]");
    console.error("   or: node src/scripts/testDependents.js <symbol_name> <repo_id> [--maxDepth=X]");
    process.exit(1);
  }

  const symbolName = filteredArgs[0];
  let owner;
  let name;
  let repoId;

  if (filteredArgs.length >= 3) {
    owner = filteredArgs[1];
    name = filteredArgs[2];
  } else if (!isNaN(parseInt(filteredArgs[1], 10)) && !filteredArgs[1].includes("/")) {
    repoId = parseInt(filteredArgs[1], 10);
  } else if (filteredArgs[1].includes("/")) {
    [owner, name] = filteredArgs[1].split("/", 2);
  } else {
    console.error("Error: Please provide both owner and name (e.g. 'namantyagi701 gitRag' or 'namantyagi701/gitRag')");
    process.exit(1);
  }

  return { symbolName, owner, name, repoId, maxDepth };
}

function printTable(rows) {
  console.log(`------------------------------------------------------------------------------------------------------`);
  console.log(
    `| ${"Hop".padEnd(4)} | ${"Symbol Name".padEnd(30)} | ${"Type".padEnd(10)} | ${"File Path".padEnd(42)} |`
  );
  console.log(`------------------------------------------------------------------------------------------------------`);

  for (const item of rows) {
    const hop = String(item.hop_distance).padEnd(4);
    const symName = (item.symbol_name.length > 30 ? item.symbol_name.slice(0, 27) + "..." : item.symbol_name).padEnd(30);
    const symType = item.symbol_type.padEnd(10);
    const filePath = (item.file_path.length > 42 ? item.file_path.slice(0, 39) + "..." : item.file_path).padEnd(42);

    console.log(`| ${hop} | ${symName} | ${symType} | ${filePath} |`);
  }

  console.log(`------------------------------------------------------------------------------------------------------\n`);
}

async function main() {
  const { symbolName, owner, name, repoId: rawRepoId, maxDepth } = parseArgs();

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
  console.log(` GitRAG Dependency Graph Traversal`);
  console.log(`========================================`);
  console.log(`Target Symbol : "${symbolName}"`);
  console.log(`Repository    : ${repoName} (ID: ${repoId})`);
  console.log(`Max Depth     : ${maxDepth}\n`);

  // 2. Find matching symbol(s) in this repo
  const symbols = await prisma.symbol.findMany({
    where: {
      repo_id: repoId,
      symbol_name: symbolName
    },
    include: {
      file: true
    },
    orderBy: {
      id: "asc"
    }
  });

  if (symbols.length === 0) {
    console.log(`Symbol '${symbolName}' not found in repository ${repoName}.\n`);
    return;
  }

  console.log(`Found ${symbols.length} symbol match(es) for '${symbolName}':\n`);

  for (const sym of symbols) {
    console.log(`>>> Symbol: "${sym.symbol_name}" (ID: ${sym.id}) [${sym.symbol_type}] in ${sym.file.file_path}`);

    // Section A: Dependents (What calls this symbol)
    console.log(`\n[Section A: Dependents (Who calls ${sym.symbol_name})]`);
    const dependents = await findDependents({
      symbolId: sym.id,
      prisma,
      maxDepth
    });

    if (dependents.length === 0) {
      console.log(`No dependents found (no symbols call this symbol within ${maxDepth} hops).\n`);
    } else {
      console.log(`Total Dependents: ${dependents.length}`);
      printTable(dependents);
    }

    // Section B: Dependencies (What this symbol calls)
    console.log(`[Section B: Dependencies (What ${sym.symbol_name} calls)]`);
    const dependencies = await findDependencies({
      symbolId: sym.id,
      prisma,
      maxDepth
    });

    if (dependencies.length === 0) {
      console.log(`No dependencies found (this symbol calls no other symbols within ${maxDepth} hops).\n`);
    } else {
      console.log(`Total Dependencies: ${dependencies.length}`);
      printTable(dependencies);
    }
    console.log(`------------------------------------------------------------------------------------------------------\n`);
  }
}

main()
  .catch((err) => {
    console.error("Traversal failed with error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
