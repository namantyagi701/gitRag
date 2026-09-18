/**
 * GitHub Webhook Route Handler
 *
 * Receives and validates GitHub PR webhooks, and enqueues PR analysis jobs.
 */

const express = require("express");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { prAnalysisQueue } = require("../queue/prAnalysisQueue");

const router = express.Router();
const prisma = new PrismaClient();

/**
 * Timing-safe HMAC-SHA256 signature verification
 */
function verifyGitHubSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret || !rawBody) {
    return false;
  }

  const parts = signatureHeader.split("=");
  if (parts.length !== 2 || parts[0] !== "sha256") {
    return false;
  }

  const signatureHex = parts[1];
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(rawBody);
  const digestHex = hmac.digest("hex");

  const sigBuf = Buffer.from(signatureHex, "utf8");
  const digestBuf = Buffer.from(digestHex, "utf8");

  if (sigBuf.length !== digestBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(sigBuf, digestBuf);
}

/**
 * POST /webhook/github
 */
router.post("/github", async (req, res) => {
  const signature = req.headers["x-hub-signature-256"];
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!secret) {
    console.error("[Webhook ERROR] GITHUB_WEBHOOK_SECRET is not configured in .env");
    return res.status(500).json({ error: "Server webhook secret configuration error" });
  }

  // 1. Verify GitHub webhook signature using raw body bytes
  const rawBody = req.rawBody;
  if (!rawBody || !verifyGitHubSignature(rawBody, signature, secret)) {
    console.warn(`[Webhook WARN] Invalid signature received from ${req.ip || "client"}`);
    return res.status(401).json({ error: "Invalid signature" });
  }

  const payload = req.body;

  // 2. Only process 'opened' or 'synchronize' actions
  const action = payload.action;
  if (action !== "opened" && action !== "synchronize") {
    console.log(`[Webhook] Ignoring PR action '${action}'`);
    return res.status(200).json({ message: `Ignored action: ${action}` });
  }

  // 3. Extract fields from payload
  if (!payload.repository || !payload.pull_request) {
    console.warn("[Webhook WARN] Malformed payload: missing repository or pull_request");
    return res.status(400).json({ error: "Malformed payload" });
  }

  const owner = payload.repository.owner?.login || payload.repository.owner?.name;
  const name = payload.repository.name;
  const prNumber = payload.pull_request.number;
  const baseSha = payload.pull_request.base?.sha;
  const headSha = payload.pull_request.head?.sha;
  const headRepoFullName = payload.pull_request.head?.repo?.full_name;
  const baseRepoFullName = payload.pull_request.base?.repo?.full_name;
  const repoUrl = payload.repository.clone_url;

  if (!owner || !name || !prNumber || !baseSha || !headSha) {
    console.warn("[Webhook WARN] Missing required PR fields in payload");
    return res.status(400).json({ error: "Missing required PR parameters" });
  }

  // 4. Fork PR check
  if (headRepoFullName && baseRepoFullName && headRepoFullName !== baseRepoFullName) {
    console.log(`[Webhook] Skipping fork PR (${headRepoFullName} -> ${baseRepoFullName}) — out of scope for v1`);
    return res.status(200).json({ message: "Fork PRs not supported in v1" });
  }

  // 5. Check if repo is registered in DB
  const repo = await prisma.repo.findFirst({
    where: { owner, name }
  });

  if (!repo) {
    console.log(`[Webhook] Unregistered repo ${owner}/${name}, skipping`);
    return res.status(200).json({ message: "Unregistered repo, skipping" });
  }

  // 6. Enqueue analysis job and respond immediately
  console.log(`[Webhook] Enqueueing PR analysis for ${owner}/${name} #${prNumber} (${baseSha} -> ${headSha})`);
  await prAnalysisQueue.add("analyze-pr", {
    owner,
    name,
    prNumber,
    baseSha,
    headSha,
    repoUrl
  });

  return res.status(200).json({
    status: "enqueued",
    repo: `${owner}/${name}`,
    prNumber,
    baseSha,
    headSha
  });
});

module.exports = router;
