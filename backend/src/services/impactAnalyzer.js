/**
 * PR Impact Analyzer
 *
 * Combines graph traversal (dependencyGraph.js) and hybrid search (hybridSearch.js)
 * across PR changed symbols to generate verified and semantic impact records.
 */

const { findDependents } = require("./dependencyGraph");
const { hybridSearch } = require("./hybridSearch");
const { prepareEmbeddingText } = require("../ingestion/embedder");

/**
 * Analyze downstream impact of changed symbols in a pull request.
 *
 * @param {Object} params
 * @param {number} params.prId - ID of pull_requests record
 * @param {Array<Object>} params.changedSymbols - Changed symbols returned by processPrDiff
 * @param {number} params.repoId - Repository ID
 * @param {Function} params.embedder - Xenova embedding pipeline
 * @param {Object} params.prisma - PrismaClient instance
 * @param {number} [params.semanticLimit=5] - Maximum semantic search results per changed symbol
 * @param {number} [params.semanticMinScore=0.5] - Minimum combined score threshold for semantic matches
 * @returns {Promise<{ totalImpactRows: number, byRelationType: Object, impactRows: Array<Object> }>}
 */
async function analyzeImpact({
  prId,
  changedSymbols,
  repoId,
  embedder,
  prisma,
  semanticLimit = 5,
  semanticMinScore = 0.5
}) {
  if (!prId || !Array.isArray(changedSymbols) || !repoId || !embedder || !prisma) {
    throw new Error("Missing required parameters for analyzeImpact");
  }

  // Clear prior pr_impacts rows for this PR in case of re-run
  await prisma.prImpact.deleteMany({
    where: { pr_id: prId }
  });

  const impactRows = [];

  for (const symbol of changedSymbols) {
    const capturedImpactedIds = new Set();

    // 1. Graph-based impact (only when symbol_id is not null)
    if (symbol.symbol_id != null) {
      const dependents = await findDependents({
        symbolId: symbol.symbol_id,
        prisma,
        maxDepth: 2
      });

      for (const dep of dependents) {
        if (dep.symbol_id === symbol.symbol_id) {
          continue;
        }
        capturedImpactedIds.add(dep.symbol_id);
        const isDirect = dep.hop_distance === 1;

        impactRows.push({
          pr_id: prId,
          source_symbol: symbol,
          source_symbol_id: symbol.symbol_id,
          impacted_symbol_id: dep.symbol_id,
          impacted_symbol_name: dep.symbol_name,
          impacted_symbol_type: dep.symbol_type,
          impacted_file_path: dep.file_path,
          relation_type: isDirect ? "direct_call" : "transitive_call",
          hop_distance: dep.hop_distance,
          rerank_score: null,
          severity: isDirect ? "high" : "medium",
          reason: isDirect
            ? `Directly calls ${symbol.symbol_name}, which was ${symbol.change_type} in this PR`
            : `Transitively depends on ${symbol.symbol_name} via ${dep.hop_distance} hops`
        });
      }
    }

    // 2. Search-based impact (run for ALL changed symbols including added)
    const query = prepareEmbeddingText(
      symbol.symbol_name,
      symbol.docstring,
      symbol.code_body || ""
    );

    if (query && query.trim()) {
      // semanticMinScore is intentionally higher than hybridSearch()'s own 
      // default (0.3) — that default was calibrated against nonsense-query 
      // noise, but same-codebase functions cluster together semantically 
      // even when functionally unrelated, so impact reports need a stricter 
      // bar to avoid drowning real signal in plausible-looking noise.
      //
      // Headroom buffer (+10): hybridSearch() is called with a buffer to absorb
      // self-match (the changed symbol itself) and graph-dedup exclusions before
      // truncating in JS. Note that this +10 buffer is a heuristic headroom, not an
      // absolute guarantee (e.g. symbols with >10 graph callers could exhaust it);
      // a fully correct fix would require hybridSearch() to accept an excludeIds
      // parameter and filter at the SQL level before LIMIT is applied.
      const candidatePool = await hybridSearch({
        query,
        repoId,
        embedder,
        prisma,
        minScore: semanticMinScore,
        limit: semanticLimit + 10
      });

      console.log(`\n[DEBUG raw candidatePool results for ${symbol.symbol_name}] count: ${candidatePool.length}`);
      console.log(JSON.stringify(candidatePool.map((r, idx) => ({
        rank: idx + 1,
        symbol_id: r.symbol_id,
        symbol_name: r.symbol_name,
        combined_score: r.combined_score
      })), null, 2));
      console.log("");

      const filteredResults = [];
      for (const res of candidatePool) {
        // Exclude the changed symbol itself
        if (symbol.symbol_id != null && res.symbol_id === symbol.symbol_id) {
          continue;
        }
        if (
          symbol.symbol_id == null &&
          res.symbol_name === symbol.symbol_name &&
          res.file_path === symbol.file_path
        ) {
          continue;
        }

        // Exclude any symbol_id already captured via graph traversal for this source symbol
        if (capturedImpactedIds.has(res.symbol_id)) {
          continue;
        }

        filteredResults.push(res);
      }

      // Truncate filtered results down to semanticLimit
      const finalSemanticResults = filteredResults.slice(0, semanticLimit);

      for (const res of finalSemanticResults) {
        capturedImpactedIds.add(res.symbol_id);

        impactRows.push({
          pr_id: prId,
          source_symbol: symbol,
          source_symbol_id: symbol.symbol_id,
          impacted_symbol_id: res.symbol_id,
          impacted_symbol_name: res.symbol_name,
          impacted_symbol_type: res.symbol_type,
          impacted_file_path: res.file_path,
          relation_type: "semantic",
          hop_distance: null,
          rerank_score: res.combined_score,
          severity: "low",
          reason: `Semantically related to changed code in ${symbol.symbol_name} (unconfirmed relationship)`
        });
      }
    }
  }

  // 3. Insert pr_impacts rows
  if (impactRows.length > 0) {
    await prisma.prImpact.createMany({
      data: impactRows.map((r) => ({
        pr_id: r.pr_id,
        source_symbol_id: r.source_symbol_id,
        impacted_symbol_id: r.impacted_symbol_id,
        relation_type: r.relation_type,
        hop_distance: r.hop_distance,
        rerank_score: r.rerank_score,
        severity: r.severity,
        reason: r.reason
      }))
    });
  }

  // 4. Update pull_requests row status to 'completed'
  await prisma.pullRequest.update({
    where: { id: prId },
    data: { status: "completed" }
  });

  const byRelationType = {
    direct_call: impactRows.filter((r) => r.relation_type === "direct_call").length,
    transitive_call: impactRows.filter((r) => r.relation_type === "transitive_call").length,
    semantic: impactRows.filter((r) => r.relation_type === "semantic").length
  };

  return {
    totalImpactRows: impactRows.length,
    byRelationType,
    impactRows
  };
}

module.exports = {
  analyzeImpact
};
