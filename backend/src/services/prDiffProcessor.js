 /**
 * PR Diff Processor
 *
 * Symbol diffing must be computed directly from git content at both SHAs,
 * never from the live `symbols` table, because the DB's current state can
 * correspond to any point in git history, not necessarily base_sha or head_sha.
 */

const path = require("path");
const simpleGit = require("simple-git");
const { SUPPORTED_SYMBOL_EXTENSIONS } = require("../ingestion/constants");
const { extractSymbolsFromSource } = require("../ingestion/astParsers");

/**
 * Process diff between baseSha and headSha to extract added, modified, and removed symbols.
 *
 * @param {Object} params
 * @param {string} params.repoPath - Local filesystem path to repository
 * @param {Object} params.repo - Repo record from database (must include id)
 * @param {number} params.prNumber - Pull request number
 * @param {string} params.baseSha - Base commit SHA
 * @param {string} params.headSha - Head commit SHA
 * @param {Object} params.prisma - PrismaClient instance
 * @returns {Promise<{ prId: number, changedSymbols: Array<Object> }>}
 */
async function processPrDiff({ repoPath, repo, prNumber, baseSha, headSha, prisma }) {
  if (!repoPath || !repo || !repo.id || !prNumber || !baseSha || !headSha || !prisma) {
    throw new Error("Missing required parameters for processPrDiff");
  }

  const resolvedRepoPath = path.resolve(process.cwd(), repoPath);
  const git = simpleGit(resolvedRepoPath);

  // 1. Verify commits exist in git
  try {
    await git.revparse(["--verify", `${baseSha}^{commit}`]);
  } catch (err) {
    throw new Error(`Invalid baseSha: commit '${baseSha}' does not exist in repository.`);
  }

  try {
    await git.revparse(["--verify", `${headSha}^{commit}`]);
  } catch (err) {
    throw new Error(`Invalid headSha: commit '${headSha}' does not exist in repository.`);
  }

  const gitRoot = (await git.revparse(["--show-toplevel"])).trim();

  // 2. Fetch changed files via git diff --name-status baseSha headSha
  const rawDiff = await git.raw(["diff", "--name-status", baseSha, headSha]);
  const diffLines = rawDiff.split("\n").map((line) => line.trim()).filter(Boolean);

  const changedSymbols = [];

  for (const line of diffLines) {
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;

    const statusCode = parts[0];
    const rawFilePath = parts[parts.length - 1]; // Handles rename target if R100 old new

    // Handle renamed/copied files explicitly
    if (statusCode.startsWith("R") || statusCode.startsWith("C")) {
      console.warn(`[WARN] Skipping renamed/copied file ${rawFilePath} — rename detection not supported in v1`);
      continue;
    }

    const fullPath = path.resolve(gitRoot, rawFilePath);
    const dbFilePath = path.relative(resolvedRepoPath, fullPath).replace(/\\/g, "/");
    const gitPath = path.relative(gitRoot, fullPath).replace(/\\/g, "/");

    const ext = path.extname(dbFilePath).toLowerCase();
    if (!SUPPORTED_SYMBOL_EXTENSIONS.has(ext)) {
      continue;
    }

    // 4. File deleted entirely in git ('D')
    if (statusCode === "D") {
      let baseContent = "";
      try {
        baseContent = await git.show([`${baseSha}:${gitPath}`]);
      } catch (err) {
        console.warn(`[WARN] Failed to fetch base content for deleted file ${dbFilePath} at ${baseSha}: ${err.message}`);
        continue;
      }

      let baseSymbols = [];
      try {
        baseSymbols = extractSymbolsFromSource(baseContent, ext);
      } catch (err) {
        console.warn(`[WARN] Failed to parse base AST for deleted file ${dbFilePath} at ${baseSha}: ${err.message}`);
        continue;
      }

      for (const sym of baseSymbols) {
        changedSymbols.push({
          symbol_id: null,
          symbol_name: sym.symbol_name,
          symbol_type: sym.symbol_type,
          file_path: dbFilePath,
          change_type: "removed"
        });
      }
      continue;
    }

    // Non-deleted, non-renamed changed file:
    // a. Get content at HEAD_SHA (if fails, treat as deleted)
    let headContent = null;
    try {
      headContent = await git.show([`${headSha}:${gitPath}`]);
    } catch (err) {
      // File deleted or not accessible at head -> treat as D
    }

    if (headContent === null) {
      let baseContent = "";
      try {
        baseContent = await git.show([`${baseSha}:${gitPath}`]);
      } catch (err) {
        continue;
      }

      let baseSymbols = [];
      try {
        baseSymbols = extractSymbolsFromSource(baseContent, ext);
      } catch (err) {
        continue;
      }

      for (const sym of baseSymbols) {
        changedSymbols.push({
          symbol_id: null,
          symbol_name: sym.symbol_name,
          symbol_type: sym.symbol_type,
          file_path: dbFilePath,
          change_type: "removed"
        });
      }
      continue;
    }

    // b. Get content at BASE_SHA (if fails, file didn't exist at base -> baseSymbols = [])
    let baseContent = null;
    try {
      baseContent = await git.show([`${baseSha}:${gitPath}`]);
    } catch (err) {
      // Genuinely new file at headSha: baseSymbols will remain empty
    }

    let baseSymbols = [];
    if (baseContent !== null) {
      try {
        baseSymbols = extractSymbolsFromSource(baseContent, ext);
      } catch (err) {
        console.warn(`[WARN] Failed to parse base AST for ${dbFilePath} at ${baseSha}: ${err.message}`);
        baseSymbols = [];
      }
    }

    // c. Run extractSymbolsFromSource on head content
    let headSymbols = [];
    try {
      headSymbols = extractSymbolsFromSource(headContent, ext);
    } catch (err) {
      console.warn(`[WARN] Failed to parse head AST for ${dbFilePath} at ${headSha}: ${err.message}`);
      headSymbols = [];
    }

    const baseSymbolsByName = new Map(baseSymbols.map((s) => [s.symbol_name, s]));
    const headSymbolsByName = new Map(headSymbols.map((s) => [s.symbol_name, s]));

    // 3. Diff baseSymbols vs headSymbols by symbol_name
    // a. In headSymbols, not in baseSymbols -> 'added'
    // b. In both, but content_hash differs -> 'modified'
    // d. In both with same content_hash -> unchanged (skip)
    for (const headSym of headSymbols) {
      if (!baseSymbolsByName.has(headSym.symbol_name)) {
        changedSymbols.push({
          symbol_id: null,
          symbol_name: headSym.symbol_name,
          symbol_type: headSym.symbol_type,
          file_path: dbFilePath,
          change_type: "added"
        });
      } else {
        const baseSym = baseSymbolsByName.get(headSym.symbol_name);
        if (baseSym.content_hash !== headSym.content_hash) {
          changedSymbols.push({
            symbol_id: null,
            symbol_name: headSym.symbol_name,
            symbol_type: headSym.symbol_type,
            file_path: dbFilePath,
            change_type: "modified"
          });
        }
      }
    }

    // c. In baseSymbols, not in headSymbols -> 'removed'
    for (const baseSym of baseSymbols) {
      if (!headSymbolsByName.has(baseSym.symbol_name)) {
        changedSymbols.push({
          symbol_id: null,
          symbol_name: baseSym.symbol_name,
          symbol_type: baseSym.symbol_type,
          file_path: dbFilePath,
          change_type: "removed"
        });
      }
    }
  }

  // 5. Best-effort DB lookup for each entry to attach symbol_id where possible:
  // - For 'added': symbol_id stays null
  // - For 'modified' or 'removed': query DB, leave null if not found
  for (const item of changedSymbols) {
    if (item.change_type === "added") {
      item.symbol_id = null;
    } else {
      const found = await prisma.symbol.findFirst({
        where: {
          symbol_name: item.symbol_name,
          file: {
            repo_id: repo.id,
            file_path: item.file_path
          }
        },
        select: { id: true }
      });
      item.symbol_id = found ? found.id : null;
    }
  }

  // 6. Upsert pull_requests row with 'processing' status
  const pr = await prisma.pullRequest.upsert({
    where: {
      repo_id_pr_number_head_sha: {
        repo_id: repo.id,
        pr_number: prNumber,
        head_sha: headSha
      }
    },
    update: {
      base_sha: baseSha,
      status: "processing"
    },
    create: {
      repo_id: repo.id,
      pr_number: prNumber,
      base_sha: baseSha,
      head_sha: headSha,
      status: "processing"
    }
  });

  // 7. Delete prior pr_changed_symbols rows in case of re-run
  await prisma.prChangedSymbol.deleteMany({
    where: { pr_id: pr.id }
  });

  // 8. Insert changed symbols with symbol_name and file_path populated on every row
  if (changedSymbols.length > 0) {
    await prisma.prChangedSymbol.createMany({
      data: changedSymbols.map((s) => ({
        pr_id: pr.id,
        symbol_id: s.symbol_id,
        symbol_name: s.symbol_name,
        file_path: s.file_path,
        change_type: s.change_type
      }))
    });
  }

  // 9. Update pull_requests row status to 'diffed'
  await prisma.pullRequest.update({
    where: { id: pr.id },
    data: { status: "diffed" }
  });

  return {
    prId: pr.id,
    changedSymbols
  };
}

module.exports = {
  processPrDiff
};
