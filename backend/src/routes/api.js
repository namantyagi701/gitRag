// No auth on these routes yet — anyone who can reach this server can read all repo/PR/impact data. Fine for local dev, must be addressed before any public deployment.

const express = require("express");
const cors = require("cors");
const { PrismaClient } = require("@prisma/client");
const { findDependents, findDependencies } = require("../services/dependencyGraph");
const { groupAndSortImpacts } = require("../services/reportFormatter");

const router = express.Router();
const prisma = new PrismaClient();

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
// 1. GET /repos
// List all registered repos ordered by created_at DESC.
// ============================================================================
router.get("/repos", async (req, res) => {
  try {
    const repos = await prisma.repo.findMany({
      orderBy: { created_at: "desc" },
      select: {
        id: true,
        owner: true,
        name: true,
        default_branch: true,
        last_indexed_sha: true,
        created_at: true
      }
    });

    return res.json(repos);
  } catch (err) {
    console.error("[API ERROR] GET /repos:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// 2. GET /repos/:owner/:name
// Get a single repo's details plus basic stats (fileCount, symbolCount, edgeCount).
// ============================================================================
router.get("/repos/:owner/:name", async (req, res) => {
  const { owner, name } = req.params;

  try {
    const repo = await prisma.repo.findFirst({
      where: { owner, name }
    });

    if (!repo) {
      return res.status(404).json({ error: "Repository not found" });
    }

    const [fileCount, symbolCount, edgeCount] = await Promise.all([
      prisma.file.count({
        where: { repo_id: repo.id }
      }),
      prisma.symbol.count({
        where: { repo_id: repo.id }
      }),
      prisma.symbolEdge.count({
        where: { caller_symbol: { repo_id: repo.id } }
      })
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
      edgeCount
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
