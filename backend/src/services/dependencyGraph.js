/**
 * Dependency graph traversal service using PostgreSQL recursive CTEs.
 */

/**
 * Find all symbols that depend on the given symbol (callers, directly or transitively).
 *
 * @param {Object} params
 * @param {number} params.symbolId - Target symbol ID
 * @param {Object} params.prisma - PrismaClient instance
 * @param {number} [params.maxDepth=2] - Maximum traversal depth
 * @returns {Promise<Array<Object>>} Array of dependent symbols with shortest hop_distance
 */
async function findDependents({ symbolId, prisma, maxDepth = 2 }) {
  if (symbolId === undefined || symbolId === null) {
    throw new Error("symbolId is required");
  }

  if (typeof maxDepth !== "number" || maxDepth <= 0) {
    return [];
  }

  const rows = await prisma.$queryRaw`
    WITH RECURSIVE dependents AS (
      -- Base case: symbols that directly call the target symbol
      SELECT 
        se.caller_symbol_id AS symbol_id,
        1 AS hop_distance
      FROM symbol_edges se
      WHERE se.callee_symbol_id = ${symbolId}

      UNION ALL

      -- Recursive case: walk outward from each already-found caller
      SELECT 
        se.caller_symbol_id AS symbol_id,
        d.hop_distance + 1 AS hop_distance
      FROM symbol_edges se
      JOIN dependents d ON se.callee_symbol_id = d.symbol_id
      WHERE d.hop_distance < ${maxDepth}
    )
    SELECT 
      d.symbol_id,
      MIN(d.hop_distance)::int AS hop_distance,
      s.symbol_name,
      s.symbol_type,
      f.file_path
    FROM dependents d
    JOIN symbols s ON s.id = d.symbol_id
    JOIN files f ON s.file_id = f.id
    GROUP BY d.symbol_id, s.symbol_name, s.symbol_type, f.file_path
    ORDER BY hop_distance ASC, s.symbol_name ASC;
  `;

  return rows.map((row) => ({
    symbol_id: Number(row.symbol_id),
    symbol_name: row.symbol_name,
    symbol_type: row.symbol_type,
    file_path: row.file_path,
    hop_distance: Number(row.hop_distance)
  }));
}

/**
 * Find all symbols that the given symbol depends on (callees, directly or transitively).
 *
 * @param {Object} params
 * @param {number} params.symbolId - Target symbol ID
 * @param {Object} params.prisma - PrismaClient instance
 * @param {number} [params.maxDepth=2] - Maximum traversal depth
 * @returns {Promise<Array<Object>>} Array of dependency symbols with shortest hop_distance
 */
async function findDependencies({ symbolId, prisma, maxDepth = 2 }) {
  if (symbolId === undefined || symbolId === null) {
    throw new Error("symbolId is required");
  }

  if (typeof maxDepth !== "number" || maxDepth <= 0) {
    return [];
  }

  const rows = await prisma.$queryRaw`
    WITH RECURSIVE dependencies AS (
      -- Base case: symbols that the target symbol directly calls
      SELECT 
        se.callee_symbol_id AS symbol_id,
        1 AS hop_distance
      FROM symbol_edges se
      WHERE se.caller_symbol_id = ${symbolId}

      UNION ALL

      -- Recursive case: walk inward to symbols called by already-found callees
      SELECT 
        se.callee_symbol_id AS symbol_id,
        d.hop_distance + 1 AS hop_distance
      FROM symbol_edges se
      JOIN dependencies d ON se.caller_symbol_id = d.symbol_id
      WHERE d.hop_distance < ${maxDepth}
    )
    SELECT 
      d.symbol_id,
      MIN(d.hop_distance)::int AS hop_distance,
      s.symbol_name,
      s.symbol_type,
      f.file_path
    FROM dependencies d
    JOIN symbols s ON s.id = d.symbol_id
    JOIN files f ON s.file_id = f.id
    GROUP BY d.symbol_id, s.symbol_name, s.symbol_type, f.file_path
    ORDER BY hop_distance ASC, s.symbol_name ASC;
  `;

  return rows.map((row) => ({
    symbol_id: Number(row.symbol_id),
    symbol_name: row.symbol_name,
    symbol_type: row.symbol_type,
    file_path: row.file_path,
    hop_distance: Number(row.hop_distance)
  }));
}

module.exports = {
  findDependents,
  findDependencies
};
