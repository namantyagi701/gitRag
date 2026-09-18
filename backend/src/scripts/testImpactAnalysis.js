#!/usr/bin/env node

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const { PrismaClient } = require("@prisma/client");
const { loadEmbedder } = require("../ingestion/embedder");
const { processPrDiff } = require("../services/prDiffProcessor");
const { analyzeImpact } = require("../services/impactAnalyzer");

const prisma = new PrismaClient();

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length < 5) {
    console.error("Usage: node src/scripts/testImpactAnalysis.js <repoPath> <owner> <name> <prNumber> <baseSha> <headSha>");
    console.error("   or: node src/scripts/testImpactAnalysis.js <repoPath> <owner/name> <prNumber> <baseSha> <headSha>");
    console.error("\nExample:");
    console.error("  node src/scripts/testImpactAnalysis.js . namantyagi701 gitRag 3 <baseSha> <headSha>");
    process.exit(1);
  }

  const repoPath = args[0];
  let owner;
  let name;
  let prNumber;
  let baseSha;
  let headSha;

  if (args.length >= 6) {
    owner = args[1];
    name = args[2];
    prNumber = parseInt(args[3], 10);
    baseSha = args[4];
    headSha = args[5];
  } else {
    const repoSlug = args[1];
    if (repoSlug.includes("/")) {
      [owner, name] = repoSlug.split("/", 2);
    } else {
      console.error("Error: Please specify owner and name, e.g. 'owner name' or 'owner/name'");
      process.exit(1);
    }
    prNumber = parseInt(args[2], 10);
    baseSha = args[3];
    headSha = args[4];
  }

  if (isNaN(prNumber)) {
    console.error(`Error: prNumber '${args[3]}' must be an integer.`);
    process.exit(1);
  }

  return { repoPath, owner, name, prNumber, baseSha, headSha };
}

async function main() {
  const { repoPath, owner, name, prNumber, baseSha, headSha } = parseArgs();

  try {
    const repo = await prisma.repo.findFirst({
      where: { owner, name }
    });

    if (!repo) {
      console.error(`Error: Repository '${owner}/${name}' not found in database.`);
      process.exit(1);
    }

    console.log(`\n================================================================================`);
    console.log(`PR Impact Analysis: ${owner}/${name} (Repo ID: ${repo.id})`);
    console.log(`PR Number: #${prNumber}`);
    console.log(`Base Commit: ${baseSha}`);
    console.log(`Head Commit: ${headSha}`);
    console.log(`================================================================================\n`);

    console.log("Loading embedding model...");
    const embedder = await loadEmbedder();
    console.log("Embedding model loaded.\n");

    console.log("Computing PR diff...");
    const { prId, changedSymbols } = await processPrDiff({
      repoPath,
      repo,
      prNumber,
      baseSha,
      headSha,
      prisma
    });

    console.log(`Identified ${changedSymbols.length} changed symbol(s). Running impact analysis...\n`);

    const result = await analyzeImpact({
      prId,
      changedSymbols,
      repoId: repo.id,
      embedder,
      prisma
    });

    // Group impacts by source symbol
    const impactsBySource = new Map();
    for (const sym of changedSymbols) {
      const key = `${sym.symbol_name}::${sym.file_path}`;
      impactsBySource.set(key, { symbol: sym, impacts: [] });
    }

    for (const impact of result.impactRows) {
      const key = `${impact.source_symbol.symbol_name}::${impact.source_symbol.file_path}`;
      if (impactsBySource.has(key)) {
        impactsBySource.get(key).impacts.push(impact);
      }
    }

    // Print report grouped by source symbol
    for (const [key, { symbol, impacts }] of impactsBySource.entries()) {
      console.log(`--------------------------------------------------------------------------------`);
      console.log(
        `Source Symbol: ${symbol.symbol_name} [${symbol.change_type.toUpperCase()}] (${symbol.symbol_type})`
      );
      console.log(`File: ${symbol.file_path} | DB Symbol ID: ${symbol.symbol_id ?? "null"}`);
      console.log(`Total Downstream Impacts: ${impacts.length}`);
      console.log(`--------------------------------------------------------------------------------`);

      if (impacts.length === 0) {
        console.log("  (No direct callers or semantic matches above threshold)\n");
        continue;
      }

      for (const imp of impacts) {
        const hops = imp.hop_distance != null ? String(imp.hop_distance) : "n/a";
        const score = imp.rerank_score != null ? Number(imp.rerank_score).toFixed(4) : "n/a";
        const symName = imp.impacted_symbol_name || `Symbol #${imp.impacted_symbol_id}`;
        const filePath = imp.impacted_file_path || "unknown file";

        console.log(`  * [${imp.severity.toUpperCase()}] ${imp.relation_type.padEnd(15)} -> ${symName} (${filePath})`);
        console.log(`    Hops: ${hops.padEnd(4)} | Score: ${score.padEnd(7)} | ID: ${imp.impacted_symbol_id}`);
        console.log(`    Reason: ${imp.reason}`);
      }
      console.log("");
    }

    console.log(`================================================================================`);
    console.log(`Impact Analysis Summary (PR #${prNumber}):`);
    console.log(`  Total Impact Rows:  ${result.totalImpactRows}`);
    console.log(`  Direct Calls:       ${result.byRelationType.direct_call}`);
    console.log(`  Transitive Calls:   ${result.byRelationType.transitive_call}`);
    console.log(`  Semantic Matches:   ${result.byRelationType.semantic}`);
    console.log(`PR Record ID: ${prId} (Status: completed)`);
    console.log(`================================================================================\n`);
  } catch (err) {
    console.error(`\n[ERROR] ${err.message}`);
    console.error(err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
