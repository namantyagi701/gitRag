const fs = require("fs");
const path = require("path");
const { computeHash } = require("../fileScanner");
const { NON_SYMBOL_EXTENSIONS, SUPPORTED_SYMBOL_EXTENSIONS } = require("../constants");
const { extractSymbolsFromSource } = require("../astParsers");

/**
 * PASS 1: Ingest files, check content hashes, and extract AST symbols
 */
async function runPass1FileIngestion({ repo, files, prisma }) {
  console.log(`[3/3] Pass 1: Ingesting files and extracting symbols via Tree-sitter...`);

  let filesScanned = 0;
  let filesSkipped = 0;
  let filesProcessed = 0;
  let filesNoSymbols = 0;
  let symbolsInserted = 0;
  const symbolsByType = {
    function: 0,
    class: 0,
    method: 0
  };

  for (const { fullPath, relPath } of files) {
    filesScanned++;

    let content;
    try {
      content = fs.readFileSync(fullPath, "utf8");
    } catch (err) {
      console.warn(`      [WARN] Could not read ${relPath}: ${err.message}`);
      continue;
    }

    const contentHash = computeHash(content);

    // Check if file is unchanged
    const existingFile = await prisma.file.findUnique({
      where: {
        repo_id_file_path: {
          repo_id: repo.id,
          file_path: relPath
        }
      }
    });

    if (existingFile && existingFile.content_hash === contentHash) {
      filesSkipped++;
      continue;
    }

    // Upsert file record
    const fileRecord = await prisma.file.upsert({
      where: {
        repo_id_file_path: {
          repo_id: repo.id,
          file_path: relPath
        }
      },
      update: {
        content_hash: contentHash,
        last_parsed_at: new Date()
      },
      create: {
        repo_id: repo.id,
        file_path: relPath,
        content_hash: contentHash,
        last_parsed_at: new Date()
      }
    });

    // Delete any edges connected to old symbols before deleting symbols
    const oldSymbols = await prisma.symbol.findMany({
      where: { file_id: fileRecord.id },
      select: { id: true }
    });
    const oldSymbolIds = oldSymbols.map((s) => s.id);
    if (oldSymbolIds.length > 0) {
      await prisma.symbolEdge.deleteMany({
        where: {
          OR: [
            { caller_symbol_id: { in: oldSymbolIds } },
            { callee_symbol_id: { in: oldSymbolIds } }
          ]
        }
      });
    }

    // Safely remove existing symbols for this file to maintain idempotent live state
    await prisma.symbol.deleteMany({
      where: { file_id: fileRecord.id }
    });

    filesProcessed++;

    // Skip symbol creation if extension is non-symbol or not in JS/TS scope
    const ext = path.extname(relPath).toLowerCase();
    if (NON_SYMBOL_EXTENSIONS.has(ext) || !SUPPORTED_SYMBOL_EXTENSIONS.has(ext)) {
      filesNoSymbols++;
      continue;
    }

    // Parse AST and extract symbols
    let extracted = [];
    try {
      extracted = extractSymbolsFromSource(content, ext);
    } catch (parseErr) {
      console.warn(`      [WARN] Failed to parse AST for ${relPath}: ${parseErr.message}`);
      continue;
    }

    if (extracted.length === 0) {
      continue;
    }

    const symbolsData = extracted.map((sym) => ({
      repo_id: repo.id,
      file_id: fileRecord.id,
      symbol_name: sym.symbol_name,
      symbol_type: sym.symbol_type,
      start_line: sym.start_line,
      end_line: sym.end_line,
      code_body: sym.code_body,
      content_hash: sym.content_hash,
      docstring: sym.docstring
    }));

    // Insert symbols using createMany with fallback to individual creates
    try {
      await prisma.symbol.createMany({
        data: symbolsData
      });
    } catch (batchErr) {
      for (const sym of symbolsData) {
        await prisma.symbol.create({ data: sym });
      }
    }

    symbolsInserted += symbolsData.length;
    for (const sym of symbolsData) {
      symbolsByType[sym.symbol_type] = (symbolsByType[sym.symbol_type] || 0) + 1;
    }
  }

  return {
    filesScanned,
    filesSkipped,
    filesProcessed,
    filesNoSymbols,
    symbolsInserted,
    symbolsByType
  };
}

module.exports = {
  runPass1FileIngestion
};
