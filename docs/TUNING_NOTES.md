# System Tuning Notes

## Semantic Impact Analysis Thresholds

1. **Threshold & Result Count Defaults**:
   > `semanticMinScore` and `semanticLimit` in `impactAnalyzer.js` were tuned against a small (~20-symbol) test repository and may need retuning against a larger, more functionally diverse codebase — treat current defaults (`0.5` / `5`) as a starting point, not a final calibration.

2. **Candidate Headroom Buffer (+10)**:
   > The `+10` candidate headroom buffer in `impactAnalyzer.js` (querying `semanticLimit + 10`) is a heuristic buffer to absorb self-match (the changed symbol itself) and graph-dedup exclusions before truncating down to `semanticLimit` in JavaScript. This is a heuristic headroom, not an absolute guarantee (e.g. a symbol with more than 10 graph-matched dependents could still exhaust it). A fully robust solution would accept an `excludeIds` parameter in `hybridSearch()` and filter out exclusions directly at the SQL `WHERE` level prior to applying `LIMIT`.

3. **Debug Inspection (`DEBUG_IMPACT_ANALYSIS`)**:
   > Set `DEBUG_IMPACT_ANALYSIS=true` (or `1`) in the environment to print the complete raw `candidatePool` returned by `hybridSearch()` (including ranks, IDs, symbol names, and combined scores) before exclusions and slicing are applied.
