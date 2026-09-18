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
 * @returns {Promise<{ totalImpactRows: number, byRelationType: Object, impactRows: Array<Object> }>}
 */
async function analyzeImpact({ prId, changedSymbols, repoId, embedder, prisma }) {
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
      const searchResults = await hybridSearch({
        query,
        repoId,
        embedder,
        prisma,
        minScore: 0.3,
        limit: 10
      });

      for (const res of searchResults) {
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
