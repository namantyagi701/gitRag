const fs = require("fs");
const path = require("path");
const { SUPPORTED_SYMBOL_EXTENSIONS } = require("../constants");
const {
  extractImportsFromSource,
  extractCallsFromSource,
  resolveImportPath
} = require("../edgeExtractor");

/**
 * PASS 2: Dependency Graph Edge Extraction (symbol_edges)
 */
async function runPass2EdgeExtraction({ repo, files, prisma }) {
  console.log(`\n[Pass 2] Extracting dependency graph edges (symbol_edges)...`);

  // Query all files and symbols for this repo from the database
  const allRepoFiles = await prisma.file.findMany({
    where: { repo_id: repo.id },
    select: { id: true, file_path: true }
  });

  const allFilePathsSet = new Set(allRepoFiles.map((f) => f.file_path));

  const allRepoSymbols = await prisma.symbol.findMany({
    where: { repo_id: repo.id },
    include: { file: true }
  });

  const symbolsByFilePath = new Map();
  const symbolsByFileAndName = new Map();

  for (const sym of allRepoSymbols) {
    const fp = sym.file.file_path;
    if (!symbolsByFilePath.has(fp)) {
      symbolsByFilePath.set(fp, []);
      symbolsByFileAndName.set(fp, new Map());
    }
    symbolsByFilePath.get(fp).push(sym);
    if (!symbolsByFileAndName.get(fp).has(sym.symbol_name)) {
      symbolsByFileAndName.get(fp).set(sym.symbol_name, sym);
    }
  }

  const rawEdges = [];
  const edgeKeySet = new Set();

  for (const { fullPath, relPath } of files) {
    const ext = path.extname(relPath).toLowerCase();
    if (!SUPPORTED_SYMBOL_EXTENSIONS.has(ext)) {
      continue;
    }

    const fileSymbols = symbolsByFilePath.get(relPath) || [];
    if (fileSymbols.length === 0) {
      continue;
    }

    let content;
    try {
      content = fs.readFileSync(fullPath, "utf8");
    } catch (err) {
      continue;
    }

    let imports = [];
    let calls = [];

    try {
      imports = extractImportsFromSource(content, ext);
      calls = extractCallsFromSource(content, ext, fileSymbols);
    } catch (err) {
      console.warn(`      [WARN] Failed edge extraction for ${relPath}: ${err.message}`);
      continue;
    }

    const importsByLocalName = new Map();
    for (const imp of imports) {
      importsByLocalName.set(imp.localName, imp);
    }

    const localSymbolsMap = symbolsByFileAndName.get(relPath) || new Map();

    for (const call of calls) {
      let calleeSymbol = null;

      // a. Same-file resolution
      if (localSymbolsMap.has(call.calleeName)) {
        calleeSymbol = localSymbolsMap.get(call.calleeName);
      }
      // b. Relative import resolution
      else if (importsByLocalName.has(call.calleeName)) {
        const imp = importsByLocalName.get(call.calleeName);
        const resolvedFilePath = resolveImportPath(relPath, imp.importedPath, allFilePathsSet);
        if (resolvedFilePath && symbolsByFileAndName.has(resolvedFilePath)) {
          calleeSymbol = symbolsByFileAndName.get(resolvedFilePath).get(call.calleeName);
        }
      }

      if (calleeSymbol) {
        const edgeKey = `${call.callerSymbol.id}_${calleeSymbol.id}_calls`;
        if (!edgeKeySet.has(edgeKey)) {
          edgeKeySet.add(edgeKey);
          rawEdges.push({
            caller_symbol_id: call.callerSymbol.id,
            callee_symbol_id: calleeSymbol.id,
            edge_type: "calls"
          });
        }
      }
    }
  }

  // Insert extracted edges with skipDuplicates: true
  if (rawEdges.length > 0) {
    try {
      await prisma.symbolEdge.createMany({
        data: rawEdges,
        skipDuplicates: true
      });
    } catch (batchErr) {
      for (const edge of rawEdges) {
        await prisma.symbolEdge.upsert({
          where: {
            caller_symbol_id_callee_symbol_id_edge_type: {
              caller_symbol_id: edge.caller_symbol_id,
              callee_symbol_id: edge.callee_symbol_id,
              edge_type: edge.edge_type
            }
          },
          update: {},
          create: edge
        });
      }
    }
  }

  const totalEdgesCount = await prisma.symbolEdge.count({
    where: {
      caller_symbol: { repo_id: repo.id }
    }
  });

  return {
    totalEdgesCount
  };
}

module.exports = {
  runPass2EdgeExtraction
};
