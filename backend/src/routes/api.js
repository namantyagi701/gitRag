const express = require("express");
const cors = require("cors");
const { Octokit } = require("@octokit/rest");
const prisma = require("../db/prisma");
const requireAuth = require("../middleware/requireAuth");
const { prAnalysisQueue } = require("../queue/prAnalysisQueue");
const { findDependents, findDependencies } = require("../services/dependencyGraph");
const { groupAndSortImpacts } = require("../services/reportFormatter");

const router = express.Router();

// Permissive CORS enabled for local dev. Must be restricted to specific origin(s) before public deployment.
router.use(cors());

/**
 * Helper to parse and validate a non-negative integer parameter.
 * Returns the parsed integer, or null if invalid.
 */
function parseNonNegativeInt(val) {
  if (val === undefined || val === null) return null;
  const str = String(val).trim();
  if (!/^\d+$/.test(str)) return null;
  const parsed = parseInt(str, 10);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Helper to parse and validate a positive integer parameter (e.g. maxDepth >= 1).
 * Returns the parsed integer, or null if invalid.
 */
function parsePositiveInt(val) {
  const num = parseNonNegativeInt(val);
  return num !== null && num > 0 ? num : null;
}

// ============================================================================
// 0. GET /demo/repo
// Separate unauthenticated route hardcoded to return the one demo repo's data
// (namantyagi701/gitRag) read-only for public marketing / showcase.
// ============================================================================
router.get("/demo/repo", async (req, res) => {
  const owner = "namantyagi701";
  const name = "gitRag";

  try {
    const repo = await prisma.repo.findFirst({
      where: { owner, name },
    });

    if (!repo) {
      return res.status(404).json({ error: "Demo repository not found" });
    }

    const [fileCount, symbolCount, edgeCount] = await Promise.all([
      prisma.file.count({
        where: { repo_id: repo.id },
      }),
      prisma.symbol.count({
        where: { repo_id: repo.id },
      }),
      prisma.symbolEdge.count({
        where: { caller_symbol: { repo_id: repo.id } },
      }),
    ]);

    return res.json({
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      default_branch: repo.default_branch,
      last_indexed_sha: repo.last_indexed_sha,
      created_at: repo.created_at,
      fileCount,
      symbolCount,
      edgeCount,
    });
  } catch (err) {
    console.error("[API ERROR] GET /demo/repo:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// 1. GET /repos
// List all registered repos owned by authenticated user ordered by created_at DESC.
// ============================================================================
router.get("/repos", requireAuth, async (req, res) => {
  try {
    const repos = await prisma.repo.findMany({
      where: { user_id: req.user.id },
      orderBy: { created_at: "desc" },
      select: {
        id: true,
        owner: true,
        name: true,
        github_webhook_id: true,
        default_branch: true,
        last_indexed_sha: true,
        created_at: true,
      },
    });

    return res.json(repos);
  } catch (err) {
    console.error("[API ERROR] GET /repos:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// 1.1 GET /repos/available
// Browse user's GitHub repos where they have admin access, excluding already connected repos.
// ============================================================================
router.get("/repos/available", requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { access_token: true },
    });

    if (!user || !user.access_token) {
      return res.status(401).json({ error: "GitHub access token missing or user not found" });
    }

    const octokit = new Octokit({ auth: user.access_token });
    let page = 1;
    const per_page = 100;
    const allRepos = [];

    while (true) {
      const { data: repos } = await octokit.rest.repos.listForAuthenticatedUser({
        per_page,
        page,
        affiliation: "owner,collaborator,organization_member",
      });

      allRepos.push(...repos);
      if (repos.length < per_page) {
        break;
      }
      page++;
    }

    // Exclude repos that already have a `repos` row in GitRAG (match on owner+name)
    const existingRepos = await prisma.repo.findMany({
      select: { owner: true, name: true },
    });
    const existingSet = new Set(
      existingRepos.map((r) => `${r.owner.toLowerCase()}/${r.name.toLowerCase()}`)
    );

    const available = allRepos
      .filter((r) => r.permissions && r.permissions.admin)
      .filter((r) => !existingSet.has(r.full_name.toLowerCase()))
      .map((r) => ({
        owner: r.owner.login,
        name: r.name,
        full_name: r.full_name,
        private: r.private,
        default_branch: r.default_branch || "main",
      }));

    return res.json(available);
  } catch (err) {
    console.error("[API ERROR] GET /repos/available:", err);
    return res.status(500).json({ error: "Failed to fetch available GitHub repositories" });
  }
});

// ============================================================================
// 1.2 POST /repos/connect
// Re-verifies admin permission, registers webhook, creates repo row, enqueues ingestion.
// ============================================================================
router.post("/repos/connect", requireAuth, async (req, res) => {
  const { owner, name } = req.body || {};

  if (!owner || !name || typeof owner !== "string" || typeof name !== "string") {
    return res.status(400).json({ error: "Missing or invalid owner or name in request body" });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { access_token: true },
    });

    if (!user || !user.access_token) {
      return res.status(401).json({ error: "User access token not found" });
    }

    // 1. Re-verify admin permission via GitHub API (don't trust frontend)
    const octokit = new Octokit({ auth: user.access_token });
    let githubRepo;
    try {
      const ghRes = await octokit.rest.repos.get({ owner, repo: name });
      githubRepo = ghRes.data;
    } catch (ghErr) {
      return res.status(404).json({ error: `Repository ${owner}/${name} not found on GitHub` });
    }

    if (!githubRepo.permissions || !githubRepo.permissions.admin) {
      return res.status(403).json({ error: "Admin permissions required to connect repository and install webhook" });
    }

    // 2. Check if a `repos` row already exists for this owner/name
    const existing = await prisma.repo.findFirst({
      where: {
        owner: { equals: owner, mode: "insensitive" },
        name: { equals: name, mode: "insensitive" },
      },
    });

    if (existing) {
      return res.status(409).json({ error: `Repository ${owner}/${name} is already connected to GitRAG` });
    }

    // 3. Create the `repos` row
    let createdRepo;
    try {
      createdRepo = await prisma.repo.create({
        data: {
          user_id: req.user.id,
          owner: githubRepo.owner.login,
          name: githubRepo.name,
          default_branch: githubRepo.default_branch || "main",
        },
      });
    } catch (createErr) {
      if (createErr.code === "P2002") {
        return res.status(409).json({ error: `Repository ${owner}/${name} is already connected` });
      }
      throw createErr;
    }

    // 4. Register real webhook on GitHub
    const publicBaseUrl = process.env.PUBLIC_BASE_URL || "https://smee.io/hGFM2FpAZE4aCBAN";
    const webhookUrl = publicBaseUrl.includes("smee.io")
      ? publicBaseUrl
      : `${publicBaseUrl.replace(/\/+$/, "")}/webhook/github`;

    try {
      const hookRes = await octokit.rest.repos.createWebhook({
        owner: githubRepo.owner.login,
        repo: githubRepo.name,
        config: {
          url: webhookUrl,
          content_type: "json",
          secret: process.env.GITHUB_WEBHOOK_SECRET,
        },
        events: ["pull_request"],
      });

      // Store returned webhook id
      createdRepo = await prisma.repo.update({
        where: { id: createdRepo.id },
        data: { github_webhook_id: hookRes.data.id },
      });
      console.log(`[Repo Connect] Webhook created for ${owner}/${name}, Hook ID: ${hookRes.data.id}`);
    } catch (hookErr) {
      console.error(`[Repo Connect ERROR] Webhook creation failed: ${hookErr.message}. Rolling back repo creation...`);
      // Rollback created repo row
      await prisma.repo.delete({ where: { id: createdRepo.id } });
      return res.status(502).json({
        error: `Failed to create webhook on GitHub: ${hookErr.message}. Repository connection was rolled back.`,
      });
    }

    // 5. Enqueue an 'ingest-repo' job
    await prAnalysisQueue.add("ingest-repo", { repoId: createdRepo.id });
    console.log(`[Repo Connect] Enqueued 'ingest-repo' job for repo ID ${createdRepo.id}`);

    // 6. Return created repo row with 201 status
    return res.status(201).json(createdRepo);
  } catch (err) {
    console.error(`[API ERROR] POST /repos/connect (${owner}/${name}):`, err);
    return res.status(500).json({ error: "Internal server error during repository connection" });
  }
});

// ============================================================================
// 1.3 DELETE /repos/:id
// Disconnect a repo, delete GitHub webhook, and cascade delete all local data.
// ============================================================================
router.delete("/repos/:id", requireAuth, async (req, res) => {
  const repoId = parseNonNegativeInt(req.params.id);
  if (repoId === null) {
    return res.status(404).json({ error: "Repository not found" });
  }

  try {
    // 1. Look up repo - return 404 if not found OR if repo.user_id !== req.user.id
    const repo = await prisma.repo.findUnique({
      where: { id: repoId },
    });

    if (!repo || repo.user_id !== req.user.id) {
      return res.status(404).json({ error: "Repository not found" });
    }

    // 2. Delete GitHub webhook via Octokit using owner's access_token
    if (repo.github_webhook_id) {
      try {
        const user = await prisma.user.findUnique({
          where: { id: req.user.id },
          select: { access_token: true },
        });

        if (user && user.access_token) {
          const octokit = new Octokit({ auth: user.access_token });
          await octokit.rest.repos.deleteWebhook({
            owner: repo.owner,
            repo: repo.name,
            hook_id: repo.github_webhook_id,
          });
          console.log(`[Repo DELETE] Webhook ${repo.github_webhook_id} deleted on GitHub for ${repo.owner}/${repo.name}`);
        }
      } catch (webhookErr) {
        // Known limitation: If token is revoked or webhook already manually deleted on GitHub,
        // log warning but proceed with deleting local data anyway.
        console.warn(`[Repo DELETE WARN] Failed to delete webhook ${repo.github_webhook_id} on GitHub: ${webhookErr.message}. Proceeding with local deletion.`);
      }
    }

    // 3. Delete the repos row (Cascade deletes files, symbols, edges, PRs, impacts)
    await prisma.repo.delete({
      where: { id: repo.id },
    });

    return res.json({ success: true, message: "Repository disconnected successfully" });
  } catch (err) {
    console.error(`[API ERROR] DELETE /repos/${repoId}:`, err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// 2. GET /repos/:owner/:name
// Get a single repo's details plus basic stats (fileCount, symbolCount, edgeCount).
// Scoped to owning user (returns 404 if repo exists but not owned by user).
// ============================================================================
router.get("/repos/:owner/:name", requireAuth, async (req, res) => {
  const { owner, name } = req.params;

  try {
    const repo = await prisma.repo.findFirst({
      where: { owner, name },
    });

    if (!repo || repo.user_id !== req.user.id) {
      return res.status(404).json({ error: "Repository not found" });
    }

    const [fileCount, symbolCount, edgeCount] = await Promise.all([
      prisma.file.count({
        where: { repo_id: repo.id },
      }),
      prisma.symbol.count({
        where: { repo_id: repo.id },
      }),
      prisma.symbolEdge.count({
        where: { caller_symbol: { repo_id: repo.id } },
      }),
    ]);

    return res.json({
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      github_webhook_id: repo.github_webhook_id,
      default_branch: repo.default_branch,
      last_indexed_sha: repo.last_indexed_sha,
      created_at: repo.created_at,
      fileCount,
      symbolCount,
      edgeCount,
    });
  } catch (err) {
    console.error(`[API ERROR] GET /repos/${owner}/${name}:`, err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// 3. GET /repos/:owner/:name/pull-requests
// List all analyzed PRs for a repo, most recent first.
// Supports ?status=, ?limit=, ?offset=
// ============================================================================
router.get("/repos/:owner/:name/pull-requests", async (req, res) => {
  const { owner, name } = req.params;

  try {
    const repo = await prisma.repo.findFirst({
      where: { owner, name },
      select: { id: true }
    });

    if (!repo) {
      return res.status(404).json({ error: "Repository not found" });
    }

    let limit = 20;
    let offset = 0;

    if (req.query.limit !== undefined) {
      const parsedLimit = parseNonNegativeInt(req.query.limit);
      if (parsedLimit === null) {
        return res.status(400).json({ error: "Invalid limit parameter" });
      }
      limit = parsedLimit;
    }

    if (req.query.offset !== undefined) {
      const parsedOffset = parseNonNegativeInt(req.query.offset);
      if (parsedOffset === null) {
        return res.status(400).json({ error: "Invalid offset parameter" });
      }
      offset = parsedOffset;
    }

    const where = { repo_id: repo.id };
    if (req.query.status) {
      where.status = String(req.query.status);
    }

    const prs = await prisma.pullRequest.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: offset,
      take: limit,
      select: {
        id: true,
        pr_number: true,
        base_sha: true,
        head_sha: true,
        status: true,
        created_at: true,
        _count: {
          select: {
            pr_changed_symbols: true,
            pr_impacts: true
          }
        }
      }
    });

    const response = prs.map((pr) => ({
      id: pr.id,
      pr_number: pr.pr_number,
      base_sha: pr.base_sha,
      head_sha: pr.head_sha,
      status: pr.status,
      created_at: pr.created_at,
      changedSymbolCount: pr._count.pr_changed_symbols,
      impactCount: pr._count.pr_impacts
    }));

    return res.json(response);
  } catch (err) {
    console.error(`[API ERROR] GET /repos/${owner}/${name}/pull-requests:`, err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// 4. GET /pull-requests/:id
// Get a single PR's full detail: metadata + changed symbols + summary counts.
// ============================================================================
router.get("/pull-requests/:id", async (req, res) => {
  const prId = parseNonNegativeInt(req.params.id);
  if (prId === null) {
    return res.status(400).json({ error: "Invalid PR ID" });
  }

  try {
    const pr = await prisma.pullRequest.findUnique({
      where: { id: prId },
      include: {
        repo: {
          select: {
            owner: true,
            name: true
          }
        },
        pr_changed_symbols: {
          include: {
            symbol: {
              select: {
                symbol_type: true
              }
            }
          },
          orderBy: { id: "asc" }
        }
      }
    });

    if (!pr) {
      return res.status(404).json({ error: "Pull request not found" });
    }

    // Calculate summary counts across relation_types
    const impactGroups = await prisma.prImpact.groupBy({
      by: ["relation_type"],
      where: { pr_id: prId },
      _count: { _all: true }
    });

    const summary = {
      totalImpacts: 0,
      direct_call: 0,
      transitive_call: 0,
      semantic: 0
    };

    for (const group of impactGroups) {
      const count = group._count._all;
      summary.totalImpacts += count;
      if (Object.prototype.hasOwnProperty.call(summary, group.relation_type)) {
        summary[group.relation_type] = count;
      }
    }

    return res.json({
      id: pr.id,
      pr_number: pr.pr_number,
      base_sha: pr.base_sha,
      head_sha: pr.head_sha,
      status: pr.status,
      created_at: pr.created_at,
      repo: {
        owner: pr.repo.owner,
        name: pr.repo.name
      },
      changedSymbols: pr.pr_changed_symbols.map((cs) => ({
        symbol_name: cs.symbol_name,
        symbol_type: cs.symbol?.symbol_type || null,
        file_path: cs.file_path,
        change_type: cs.change_type
      })),
      summary
    });
  } catch (err) {
    console.error(`[API ERROR] GET /pull-requests/${req.params.id}:`, err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// 5. GET /pull-requests/:id/impacts
// Full impact report for a PR, grouped & sorted by source symbol and severity.
// ============================================================================
router.get("/pull-requests/:id/impacts", async (req, res) => {
  const prId = parseNonNegativeInt(req.params.id);
  if (prId === null) {
    return res.status(400).json({ error: "Invalid PR ID" });
  }

  try {
    const pr = await prisma.pullRequest.findUnique({
      where: { id: prId },
      include: {
        repo: {
          select: {
            owner: true,
            name: true
          }
        },
        pr_changed_symbols: {
          include: {
            symbol: {
              select: {
                symbol_type: true
              }
            }
          },
          orderBy: { id: "asc" }
        }
      }
    });

    if (!pr) {
      return res.status(404).json({ error: "Pull request not found" });
    }

    const rawImpacts = await prisma.prImpact.findMany({
      where: { pr_id: prId },
      include: {
        source_symbol: {
          select: {
            id: true,
            symbol_name: true,
            file: {
              select: { file_path: true }
            }
          }
        },
        impacted_symbol: {
          select: {
            id: true,
            symbol_name: true,
            symbol_type: true,
            file: {
              select: { file_path: true }
            }
          }
        }
      }
    });

    const changedSymbols = pr.pr_changed_symbols.map((cs) => ({
      symbol_id: cs.symbol_id,
      symbol_name: cs.symbol_name,
      symbol_type: cs.symbol?.symbol_type || null,
      file_path: cs.file_path,
      change_type: cs.change_type
    }));

    // Format raw impacts into expected output shape
    const formattedImpacts = rawImpacts.map((imp) => {
      // Resolve source symbol info from relation or fallback to matching changed symbol
      let sourceSymbolObj = null;
      if (imp.source_symbol) {
        sourceSymbolObj = {
          symbol_id: imp.source_symbol.id,
          symbol_name: imp.source_symbol.symbol_name,
          file_path: imp.source_symbol.file?.file_path || null
        };
      } else {
        const fallbackChanged = changedSymbols.find(
          (cs) => cs.symbol_id != null && cs.symbol_id === imp.source_symbol_id
        ) || (changedSymbols.length === 1 ? changedSymbols[0] : null);

        sourceSymbolObj = {
          symbol_id: imp.source_symbol_id,
          symbol_name: fallbackChanged ? fallbackChanged.symbol_name : null,
          file_path: fallbackChanged ? fallbackChanged.file_path : null
        };
      }

      return {
        source_symbol_id: imp.source_symbol_id,
        source_symbol: sourceSymbolObj,
        impacted_symbol: {
          symbol_id: imp.impacted_symbol.id,
          symbol_name: imp.impacted_symbol.symbol_name,
          symbol_type: imp.impacted_symbol.symbol_type,
          file_path: imp.impacted_symbol.file?.file_path || null
        },
        relation_type: imp.relation_type,
        hop_distance: imp.hop_distance,
        rerank_score: imp.rerank_score,
        severity: imp.severity,
        reason: imp.reason
      };
    });

    // Group and sort impacts using reportFormatter's shared logic
    const sortedImpacts = groupAndSortImpacts(changedSymbols, formattedImpacts).map((imp) => ({
      source_symbol: imp.source_symbol,
      impacted_symbol: imp.impacted_symbol,
      relation_type: imp.relation_type,
      hop_distance: imp.hop_distance,
      rerank_score: imp.rerank_score,
      severity: imp.severity,
      reason: imp.reason
    }));

    return res.json({
      prId: pr.id,
      pr_number: pr.pr_number,
      repo: {
        owner: pr.repo.owner,
        name: pr.repo.name
      },
      status: pr.status,
      changedSymbols,
      impacts: sortedImpacts
    });
  } catch (err) {
    console.error(`[API ERROR] GET /pull-requests/${req.params.id}/impacts:`, err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// 6. GET /symbols/:id
// Get a single symbol's details (code snippet, docstring, lines, file_path).
// ============================================================================
router.get("/symbols/:id", async (req, res) => {
  const symbolId = parseNonNegativeInt(req.params.id);
  if (symbolId === null) {
    return res.status(400).json({ error: "Invalid symbol ID" });
  }

  try {
    const symbol = await prisma.symbol.findUnique({
      where: { id: symbolId },
      include: {
        file: {
          select: {
            file_path: true
          }
        }
      }
    });

    if (!symbol) {
      return res.status(404).json({ error: "Symbol not found" });
    }

    return res.json({
      id: symbol.id,
      symbol_name: symbol.symbol_name,
      symbol_type: symbol.symbol_type,
      file_path: symbol.file?.file_path || null,
      start_line: symbol.start_line,
      end_line: symbol.end_line,
      docstring: symbol.docstring,
      code_body: symbol.code_body
    });
  } catch (err) {
    console.error(`[API ERROR] GET /symbols/${req.params.id}:`, err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// 7. GET /symbols/:id/dependents
// Symbols that depend on this symbol (callers, directly or transitively).
// ============================================================================
router.get("/symbols/:id/dependents", async (req, res) => {
  const symbolId = parseNonNegativeInt(req.params.id);
  if (symbolId === null) {
    return res.status(400).json({ error: "Invalid symbol ID" });
  }

  let maxDepth = 2;
  if (req.query.maxDepth !== undefined) {
    const parsedDepth = parsePositiveInt(req.query.maxDepth);
    if (parsedDepth === null) {
      return res.status(400).json({ error: "Invalid maxDepth parameter" });
    }
    maxDepth = parsedDepth;
  }

  try {
    const symbol = await prisma.symbol.findUnique({
      where: { id: symbolId },
      select: { id: true }
    });

    if (!symbol) {
      return res.status(404).json({ error: "Symbol not found" });
    }

    const dependents = await findDependents({
      symbolId,
      prisma,
      maxDepth
    });

    return res.json(dependents);
  } catch (err) {
    console.error(`[API ERROR] GET /symbols/${req.params.id}/dependents:`, err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// 8. GET /symbols/:id/dependencies
// Symbols that this symbol depends on (what this symbol calls).
// ============================================================================
router.get("/symbols/:id/dependencies", async (req, res) => {
  const symbolId = parseNonNegativeInt(req.params.id);
  if (symbolId === null) {
    return res.status(400).json({ error: "Invalid symbol ID" });
  }

  let maxDepth = 2;
  if (req.query.maxDepth !== undefined) {
    const parsedDepth = parsePositiveInt(req.query.maxDepth);
    if (parsedDepth === null) {
      return res.status(400).json({ error: "Invalid maxDepth parameter" });
    }
    maxDepth = parsedDepth;
  }

  try {
    const symbol = await prisma.symbol.findUnique({
      where: { id: symbolId },
      select: { id: true }
    });

    if (!symbol) {
      return res.status(404).json({ error: "Symbol not found" });
    }

    const dependencies = await findDependencies({
      symbolId,
      prisma,
      maxDepth
    });

    return res.json(dependencies);
  } catch (err) {
    console.error(`[API ERROR] GET /symbols/${req.params.id}/dependencies:`, err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
