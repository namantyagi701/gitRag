#!/usr/bin/env node

/**
 * BullMQ PR Analysis Worker
 *
 * Consumes 'pr-analysis' queue jobs and executes:
 * 1. Repo clone / fetch
 * 2. Full ingestion pipeline
 * 3. PR symbol diff extraction
 * 4. Downstream impact analysis
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const { Worker } = require("bullmq");
const prisma = require("../db/prisma");
const { connection } = require("./prAnalysisQueue");
const { loadEmbedder } = require("../ingestion/embedder");
const { ensureLocalClone } = require("../services/repoManager");
const { runFullIngestion } = require("../ingestion/runFullIngestion");
const { processPrDiff } = require("../services/prDiffProcessor");
const { analyzeImpact } = require("../services/impactAnalyzer");
const { formatImpactReportMarkdown } = require("../services/reportFormatter");
const { postImpactComment } = require("../services/githubCommenter");

let embedder = null;

/**
 * Main worker job processor
 */
async function processJob(job) {
  // Ensure embedder is loaded if not already initialized
  if (!embedder) {
    console.log("[Worker] Loading embedding model (Xenova/all-MiniLM-L6-v2)...");
    embedder = await loadEmbedder();
  }

  // ============================================================================
  // Branch 1: 'ingest-repo' - Initial full codebase ingestion
  // ============================================================================
  if (job.name === "ingest-repo") {
    const { repoId } = job.data;
    console.log(`\n================================================================================`);
    console.log(`[Worker] Processing Job ${job.id}: Ingest Repository (ID: ${repoId})`);
    console.log(`================================================================================\n`);

    const repo = await prisma.repo.findUnique({
      where: { id: repoId },
      include: { user: true },
    });

    if (!repo) {
      throw new Error(`Repository ID ${repoId} not found in database.`);
    }

    const localPath = await ensureLocalClone({
      owner: repo.owner,
      name: repo.name,
      accessToken: repo.user?.access_token,
    });

    let effectiveRepoPath = localPath;
    if (fs.existsSync(path.join(localPath, "backend"))) {
      const existingFile = await prisma.file.findFirst({
        where: { repo_id: repo.id },
      });
      if (existingFile && !existingFile.file_path.startsWith("backend/")) {
        effectiveRepoPath = path.join(localPath, "backend");
      }
    }

    console.log(`[Worker] Running full ingestion pipeline on ${effectiveRepoPath}...`);
    const stats = await runFullIngestion({
      repoPath: effectiveRepoPath,
      repoId: repo.id,
      embedder,
      prisma,
    });

    console.log(`\n[Worker] SUCCESS: Full ingestion completed for ${repo.owner}/${repo.name}\n`);
    return { success: true, repoId: repo.id, repo: `${repo.owner}/${repo.name}`, stats };
  }

  // ============================================================================
  // Branch 2: 'analyze-pr' - PR diff analysis and downstream impact report
  // ============================================================================
  const { owner, name, prNumber, baseSha, headSha, repoUrl } = job.data;
  console.log(`\n================================================================================`);
  console.log(`[Worker] Processing Job ${job.id}: ${owner}/${name} PR #${prNumber}`);
  console.log(`[Worker] Commits: ${baseSha} -> ${headSha}`);
  console.log(`================================================================================\n`);

  let prRecordId = null;

  try {
    // 1. Look up repo record (must already exist)
    const repo = await prisma.repo.findFirst({
      where: { owner, name },
      include: { user: true },
    });

    if (!repo) {
      throw new Error(`Repository '${owner}/${name}' not found in database.`);
    }

    // 2. Call ensureLocalClone() to get/update local repo path
    const localPath = await ensureLocalClone({
      owner,
      name,
      repoUrl,
      accessToken: repo.user?.access_token,
    });

    // Handle subfolder repositories (e.g. 'backend' subfolder for gitRag)
    let effectiveRepoPath = localPath;
    if (fs.existsSync(path.join(localPath, "backend"))) {
      const existingFile = await prisma.file.findFirst({
        where: { repo_id: repo.id },
      });
      if (existingFile && !existingFile.file_path.startsWith("backend/")) {
        effectiveRepoPath = path.join(localPath, "backend");
      }
    }

    // 3. Run full ingestion pipeline
    console.log(`[Worker] Running code ingestion on ${effectiveRepoPath}...`);
    await runFullIngestion({
      repoPath: effectiveRepoPath,
      repoId: repo.id,
      embedder,
      prisma,
    });
    console.log(`[Worker] Ingestion completed.`);

    // 4. Call processPrDiff()
    console.log(`[Worker] Extracting changed symbols between ${baseSha} and ${headSha}...`);
    const diffResult = await processPrDiff({
      repoPath: effectiveRepoPath,
      repo,
      prNumber,
      baseSha,
      headSha,
      prisma
    });
    prRecordId = diffResult.prId;
    console.log(`[Worker] PR Record ID ${prRecordId}: identified ${diffResult.changedSymbols.length} changed symbol(s).`);

    // 5. Call analyzeImpact()
    console.log(`[Worker] Analyzing downstream impacts...`);
    const impactResult = await analyzeImpact({
      prId: diffResult.prId,
      changedSymbols: diffResult.changedSymbols,
      repoId: repo.id,
      embedder,
      prisma
    });

    // 6. Format and post GitHub PR comment
    console.log(`[Worker] Generating PR comment report for PR #${prNumber}...`);
    const markdownBody = formatImpactReportMarkdown({
      changedSymbols: diffResult.changedSymbols,
      impactRows: impactResult.impactRows
    });

    const commentResult = await postImpactComment({
      owner,
      name,
      prNumber,
      markdownBody
    });

    if (commentResult.success) {
      console.log(`[Worker] Comment successfully posted to PR #${prNumber}: ${commentResult.url}`);
    } else {
      console.warn(`[Worker WARN] Could not post comment to PR #${prNumber}: ${commentResult.error}`);
    }

    // 7. Log completion summary
    console.log(`\n--------------------------------------------------------------------------------`);
    console.log(`[Worker] SUCCESS: PR #${prNumber} Impact Analysis Completed`);
    console.log(`  Total Impact Rows: ${impactResult.totalImpactRows}`);
    console.log(`  Direct Calls:      ${impactResult.byRelationType.direct_call}`);
    console.log(`  Transitive Calls:  ${impactResult.byRelationType.transitive_call}`);
    console.log(`  Semantic Matches:  ${impactResult.byRelationType.semantic}`);
    if (commentResult.url) {
      console.log(`  Comment URL:       ${commentResult.url}`);
    }
    console.log(`--------------------------------------------------------------------------------\n`);

    return {
      prId: diffResult.prId,
      totalImpactRows: impactResult.totalImpactRows,
      byRelationType: impactResult.byRelationType,
      commentUrl: commentResult.url || null
    };
  } catch (err) {
    console.error(`\n[Worker ERROR] Job ${job.id} for PR #${prNumber} failed:`, err.message);

    // Mark PR status as failed if a PR record was created or looked up
    if (prRecordId) {
      try {
        await prisma.pullRequest.update({
          where: { id: prRecordId },
          data: { status: "failed" }
        });
      } catch (updateErr) {
        console.error(`[Worker ERROR] Could not update PR status to 'failed':`, updateErr.message);
      }
    }

    throw err;
  }
}

/**
 * Initialize worker and keep process alive
 */
async function main() {
  console.log("[Worker] Loading embedding model (Xenova/all-MiniLM-L6-v2)...");
  embedder = await loadEmbedder();
  console.log("[Worker] Embedding model loaded.");

  const worker = new Worker("pr-analysis", processJob, {
    connection,
    concurrency: 1
  });

  worker.on("ready", () => {
    console.log("[Worker] BullMQ Worker 'pr-analysis' is ready and listening for jobs.\n");
  });

  worker.on("completed", (job) => {
    console.log(`[Worker] Job ${job.id} marked as completed.`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[Worker] Job ${job ? job.id : "unknown"} marked as failed: ${err.message}`);
  });

  const shutdown = async () => {
    console.log("\n[Worker] Shutting down worker...");
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[Worker FATAL] Startup failed:", err);
    process.exit(1);
  });
}

module.exports = {
  processJob
};
