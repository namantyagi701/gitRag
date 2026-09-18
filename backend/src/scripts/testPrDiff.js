#!/usr/bin/env node

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const { PrismaClient } = require("@prisma/client");
const { processPrDiff } = require("../services/prDiffProcessor");

const prisma = new PrismaClient();

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length < 5) {
    console.error("Usage: node src/scripts/testPrDiff.js <repoPath> <owner> <name> <prNumber> <baseSha> <headSha>");
    console.error("   or: node src/scripts/testPrDiff.js <repoPath> <owner/name> <prNumber> <baseSha> <headSha>");
    console.error("\nExample:");
    console.error("  node src/scripts/testPrDiff.js . namantyagi701 gitRag 1 9409dd9 026bcf2");
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
    // 5 arguments: repoPath, owner/name, prNumber, baseSha, headSha
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

function printTable(rows) {
  if (rows.length === 0) {
    console.log("No changed symbols detected between these commits.");
    return;
  }

  const colChangeType = Math.max(10, ...rows.map((r) => (r.change_type || "").length));
  const colSymbolName = Math.max(15, ...rows.map((r) => (r.symbol_name || "").length));
  const colType = Math.max(10, ...rows.map((r) => (r.symbol_type || "").length));
  const colFilePath = Math.max(20, ...rows.map((r) => (r.file_path || "").length));
  const colSymbolId = 11;

  const sep = `+${"-".repeat(colChangeType + 2)}+${"-".repeat(colSymbolName + 2)}+${"-".repeat(colType + 2)}+${"-".repeat(colFilePath + 2)}+${"-".repeat(colSymbolId + 2)}+`;

  console.log(sep);
  console.log(
    `| ${"Change".padEnd(colChangeType)} | ${"Symbol Name".padEnd(colSymbolName)} | ${"Type".padEnd(colType)} | ${"File Path".padEnd(colFilePath)} | ${"Symbol ID".padEnd(colSymbolId)} |`
  );
  console.log(sep);

  for (const row of rows) {
    const changeType = (row.change_type || "").padEnd(colChangeType);
    const symName = (row.symbol_name || "").padEnd(colSymbolName);
    const symType = (row.symbol_type || "N/A").padEnd(colType);
    const filePath = (row.file_path || "").padEnd(colFilePath);
    const symId = (row.symbol_id != null ? String(row.symbol_id) : "null (new)").padEnd(colSymbolId);

    console.log(`| ${changeType} | ${symName} | ${symType} | ${filePath} | ${symId} |`);
  }

  console.log(sep);
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

    console.log(`\nProcessing PR Diff for ${owner}/${name} (Repo ID: ${repo.id})`);
    console.log(`PR Number: #${prNumber}`);
    console.log(`Base Commit: ${baseSha}`);
    console.log(`Head Commit: ${headSha}\n`);

    const result = await processPrDiff({
      repoPath,
      repo,
      prNumber,
      baseSha,
      headSha,
      prisma
    });

    const changedSymbols = result.changedSymbols;

    printTable(changedSymbols);

    const counts = {
      added: changedSymbols.filter((s) => s.change_type === "added").length,
      modified: changedSymbols.filter((s) => s.change_type === "modified").length,
      removed: changedSymbols.filter((s) => s.change_type === "removed").length,
      total: changedSymbols.length
    };

    console.log(`\nSummary:`);
    console.log(`  Added:    ${counts.added}`);
    console.log(`  Modified: ${counts.modified}`);
    console.log(`  Removed:  ${counts.removed}`);
    console.log(`  Total:    ${counts.total}`);
    console.log(`\nPR Record ID: ${result.prId} (Status: diffed)`);
    console.log(`Saved ${changedSymbols.length} rows to pr_changed_symbols.\n`);
  } catch (err) {
    console.error(`\n[ERROR] ${err.message}`);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
