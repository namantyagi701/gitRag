#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const { PrismaClient } = require("@prisma/client");
const Parser = require("tree-sitter");
const JavaScript = require("tree-sitter-javascript");
const TypeScript = require("tree-sitter-typescript");

const prisma = new PrismaClient();

// Initialize parsers for JS, TS, and TSX
const jsParser = new Parser();
jsParser.setLanguage(JavaScript);

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);

const tsxParser = new Parser();
tsxParser.setLanguage(TypeScript.tsx);

// Directories to ignore during traversal
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".github",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  ".vscode",
  ".idea",
  "coverage",
  "vendor",
  "__pycache__",
  ".agents",
  ".claude",
  ".cursor",
  ".devin"
]);

// File extensions considered source code (tracked in files table)
const CODE_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs",
  ".ts", ".tsx", ".mts", ".cts",
  ".py", ".pyw",
  ".go",
  ".java",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx",
  ".rs",
  ".rb",
  ".php",
  ".cs",
  ".swift",
  ".kt", ".kts",
  ".scala",
  ".sql",
  ".sh", ".bash", ".zsh",
  ".html", ".css", ".scss", ".sass", ".less",
  ".vue", ".svelte",
  ".json", ".yaml", ".yml", ".toml", ".md"
]);

// Extensions where symbol extraction is not applicable (configs, styles, docs)
const NON_SYMBOL_EXTENSIONS = new Set([
  ".json", ".yaml", ".yml", ".toml", ".md",
  ".html", ".css", ".scss", ".sass", ".less"
]);

// Extensions currently supported for Tree-sitter AST symbol extraction
const SUPPORTED_SYMBOL_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs",
  ".ts", ".tsx", ".mts", ".cts"
]);

/**
 * Select the appropriate Tree-sitter parser based on file extension
 */
function getParserForExtension(ext) {
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return tsParser;
    case ".tsx":
      return tsxParser;
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
    default:
      return jsParser;
  }
}

/**
 * Compute SHA-256 hash of a string
 */
function computeHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Recursively scan directory for code files
 */
function collectCodeFiles(dirPath, rootPath, fileList = []) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    console.warn(`[WARN] Skipping directory ${dirPath}: ${err.message}`);
    return fileList;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && !IGNORED_DIRS.has(entry.name)) {
        collectCodeFiles(fullPath, rootPath, fileList);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (CODE_EXTENSIONS.has(ext)) {
        // Normalize path with forward slashes for database consistency
        const relPath = path.relative(rootPath, fullPath).replace(/\\/g, "/");
        fileList.push({
          fullPath,
          relPath
        });
      }
    }
  }

  return fileList;
}

/**
 * Extract docstring/comment block immediately preceding a node without any blank lines
 */
function extractPrecedingComment(node, lines) {
  let targetNode = node;
  while (
    targetNode.parent &&
    (targetNode.parent.type === "export_statement" ||
     targetNode.parent.type === "lexical_declaration" ||
     targetNode.parent.type === "variable_declaration")
  ) {
    targetNode = targetNode.parent;
  }

  const startRow = targetNode.startPosition.row;
  const commentLines = [];
  let currentRow = startRow - 1;

  while (currentRow >= 0) {
    const lineTrimmed = lines[currentRow].trim();
    if (lineTrimmed === "") {
      break; // Blank line encountered: stop
    }
    if (
      lineTrimmed.startsWith("//") ||
      lineTrimmed.startsWith("/*") ||
      lineTrimmed.startsWith("*") ||
      lineTrimmed.endsWith("*/")
    ) {
      commentLines.unshift(lines[currentRow]);
      currentRow--;
    } else {
      break; // Non-comment text: stop
    }
  }

  return commentLines.length > 0 ? commentLines.join("\n") : null;
}

/**
 * Parse source code using Tree-sitter and extract functions, classes, and methods
 */
function extractSymbolsFromSource(content, ext) {
  const parser = getParserForExtension(ext);
  const tree = parser.parse(content);
  const lines = content.split("\n");
  const symbols = [];

  function traverse(node) {
    // 1. function_declaration
    if (node.type === "function_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode && nameNode.text) {
        const codeBody = content.slice(node.startIndex, node.endIndex);
        symbols.push({
          symbol_name: nameNode.text,
          symbol_type: "function",
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          code_body: codeBody,
          content_hash: computeHash(codeBody),
          docstring: extractPrecedingComment(node, lines)
        });
      }
    }
    // 2. class_declaration
    else if (node.type === "class_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode && nameNode.text) {
        const codeBody = content.slice(node.startIndex, node.endIndex);
        symbols.push({
          symbol_name: nameNode.text,
          symbol_type: "class",
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          code_body: codeBody,
          content_hash: computeHash(codeBody),
          docstring: extractPrecedingComment(node, lines)
        });
      }
    }
    // 3. method_definition (inside class body)
    else if (node.type === "method_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode && nameNode.text) {
        const codeBody = content.slice(node.startIndex, node.endIndex);
        symbols.push({
          symbol_name: nameNode.text,
          symbol_type: "method",
          start_line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1,
          code_body: codeBody,
          content_hash: computeHash(codeBody),
          docstring: extractPrecedingComment(node, lines)
        });
      }
    }
    // 4. arrow_function or function_expression assigned to a variable_declarator
    else if (node.type === "variable_declarator") {
      const nameNode = node.childForFieldName("name");
      const valueNode = node.childForFieldName("value");
      if (
        nameNode &&
        nameNode.text &&
        valueNode &&
        (valueNode.type === "arrow_function" || valueNode.type === "function_expression")
      ) {
        const codeBody = content.slice(valueNode.startIndex, valueNode.endIndex);
        symbols.push({
          symbol_name: nameNode.text,
          symbol_type: "function",
          start_line: valueNode.startPosition.row + 1,
          end_line: valueNode.endPosition.row + 1,
          code_body: codeBody,
          content_hash: computeHash(codeBody),
          docstring: extractPrecedingComment(node, lines)
        });
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      traverse(node.namedChild(i));
    }
  }

  traverse(tree.rootNode);
  return symbols;
}

/**
 * Step 1: Extract ESM imports and CommonJS requires from source code
 */
function extractImportsFromSource(content, ext) {
  const parser = getParserForExtension(ext);
  const tree = parser.parse(content);
  const imports = [];

  function traverse(node) {
    // 1. ES Module import: import_statement
    if (node.type === "import_statement") {
      const sourceNode = node.childForFieldName("source");
      const importPath = sourceNode ? sourceNode.text.replace(/['"]/g, "") : null;

      if (importPath) {
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child.type === "import_clause") {
            for (let j = 0; j < child.namedChildCount; j++) {
              const spec = child.namedChild(j);
              if (spec.type === "identifier") {
                // Default import: import foo from './foo'
                imports.push({ localName: spec.text, importedPath: importPath, isNamespace: false });
              } else if (spec.type === "named_imports") {
                // Named imports: import { a, b as c } from './foo'
                for (let k = 0; k < spec.namedChildCount; k++) {
                  const item = spec.namedChild(k);
                  if (item.type === "import_specifier") {
                    const aliasNode = item.childForFieldName("alias");
                    const nameNode = item.childForFieldName("name");
                    const localName = aliasNode ? aliasNode.text : (nameNode ? nameNode.text : item.text);
                    imports.push({ localName, importedPath: importPath, isNamespace: false });
                  }
                }
              } else if (spec.type === "namespace_import") {
                // Namespace import: import * as foo from './foo'
                const nameNode = spec.namedChild(0);
                if (nameNode) {
                  imports.push({ localName: nameNode.text, importedPath: importPath, isNamespace: true });
                }
              }
            }
          }
        }
      }
    }
    // 2. CommonJS require: call_expression where callee is 'require'
    else if (node.type === "call_expression") {
      const callee = node.childForFieldName("function") || node.childForFieldName("callee") || node.firstNamedChild;
      if (callee && callee.type === "identifier" && callee.text === "require") {
        const argsNode = node.childForFieldName("arguments");
        if (argsNode && argsNode.namedChildCount > 0) {
          const arg = argsNode.namedChild(0);
          if (arg && (arg.type === "string" || arg.type === "string_fragment")) {
            const importPath = arg.text.replace(/['"]/g, "");
            const parent = node.parent;
            if (parent && parent.type === "variable_declarator") {
              const nameNode = parent.childForFieldName("name");
              if (nameNode) {
                if (nameNode.type === "identifier") {
                  // const foo = require('./foo')
                  imports.push({ localName: nameNode.text, importedPath: importPath, isNamespace: true });
                } else if (nameNode.type === "object_pattern") {
                  // const { a, b: c } = require('./foo')
                  for (let i = 0; i < nameNode.namedChildCount; i++) {
                    const prop = nameNode.namedChild(i);
                    if (prop.type === "shorthand_property_identifier_pattern" || prop.type === "identifier") {
                      imports.push({ localName: prop.text, importedPath: importPath, isNamespace: false });
                    } else if (prop.type === "pair_pattern") {
                      const value = prop.childForFieldName("value");
                      if (value) {
                        imports.push({ localName: value.text, importedPath: importPath, isNamespace: false });
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      traverse(node.namedChild(i));
    }
  }

  traverse(tree.rootNode);
  return imports;
}

/**
 * Step 2: Resolve relative import paths to actual file_paths in the repository
 */
function resolveImportPath(fromFilePath, importedPath, allFilePaths) {
  if (!importedPath.startsWith("./") && !importedPath.startsWith("../")) {
    return null; // Skip external packages or non-relative paths
  }

  const fromDir = path.dirname(fromFilePath).replace(/\\/g, "/");
  const normalized = path.posix.normalize(path.posix.join(fromDir, importedPath));

  const candidates = [
    normalized,
    normalized + ".js",
    normalized + ".ts",
    normalized + ".jsx",
    normalized + ".tsx",
    normalized + ".mjs",
    normalized + ".cjs",
    path.posix.join(normalized, "index.js"),
    path.posix.join(normalized, "index.ts"),
    path.posix.join(normalized, "index.jsx"),
    path.posix.join(normalized, "index.tsx")
  ];

  for (const candidate of candidates) {
    if (allFilePaths.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Find the nearest enclosing symbol for a given AST node
 */
function findEnclosingSymbol(node, fileSymbols) {
  let curr = node.parent;
  while (curr) {
    let candidateName = null;
    let candidateNode = null;

    if (
      curr.type === "function_declaration" ||
      curr.type === "class_declaration" ||
      curr.type === "method_definition"
    ) {
      const nameNode = curr.childForFieldName("name");
      if (nameNode && nameNode.text) {
        candidateName = nameNode.text;
        candidateNode = curr;
      }
    } else if (curr.type === "variable_declarator") {
      const nameNode = curr.childForFieldName("name");
      const val = curr.childForFieldName("value");
      if (
        nameNode &&
        nameNode.text &&
        val &&
        (val.type === "arrow_function" || val.type === "function_expression")
      ) {
        candidateName = nameNode.text;
        candidateNode = val;
      }
    }

    if (candidateName && candidateNode) {
      const startLine = candidateNode.startPosition.row + 1;
      const endLine = candidateNode.endPosition.row + 1;
      const match = fileSymbols.find(
        (s) => s.symbol_name === candidateName && s.start_line === startLine && s.end_line === endLine
      );
      if (match) return match;
    }
    curr = curr.parent;
  }
  return null;
}

/**
 * Step 3: Extract call expressions whose callee is a plain identifier
 */
function extractCallsFromSource(content, ext, fileSymbols) {
  const parser = getParserForExtension(ext);
  const tree = parser.parse(content);
  const calls = [];

  function traverse(node) {
    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function") || node.childForFieldName("callee") || node.firstNamedChild;
      if (callee && callee.type === "identifier") {
        const calleeName = callee.text;
        if (calleeName !== "require") {
          const caller = findEnclosingSymbol(node, fileSymbols);
          if (caller) {
            calls.push({
              callerSymbol: caller,
              calleeName: calleeName,
              line: node.startPosition.row + 1
            });
          }
        }
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      traverse(node.namedChild(i));
    }
  }

  traverse(tree.rootNode);
  return calls;
}

/**
 * Parse CLI arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: node src/scripts/ingest.js <path-to-repo> <owner> <name>");
    console.error("   or: node src/scripts/ingest.js <path-to-repo> <owner/name>");
    process.exit(1);
  }

  const repoPath = path.resolve(process.cwd(), args[0]);

  let owner;
  let name;

  if (args.length >= 3) {
    owner = args[1];
    name = args[2];
  } else if (args[1].includes("/")) {
    [owner, name] = args[1].split("/", 2);
  } else {
    console.error("Error: Please provide both owner and name (e.g., 'facebook' 'react' or 'facebook/react')");
    process.exit(1);
  }

  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    console.error(`Error: Repository path does not exist or is not a directory: ${repoPath}`);
    process.exit(1);
  }

  return { repoPath, owner, name };
}

async function main() {
  const { repoPath, owner, name } = parseArgs();

  console.log(`\n========================================`);
  console.log(` GitRAG Ingestion Pipeline`);
  console.log(`========================================`);
  console.log(`Repo Path : ${repoPath}`);
  console.log(`Owner     : ${owner}`);
  console.log(`Name      : ${name}\n`);

  // 1. Find or create repository row
  console.log(`[1/3] Resolving repository '${owner}/${name}' in database...`);
  const repo = await prisma.repo.upsert({
    where: {
      owner_name: { owner, name }
    },
    update: {},
    create: {
      owner,
      name,
      default_branch: "main"
    }
  });

  console.log(`      Repo ID: ${repo.id}`);

  // 2. Discover code files
  console.log(`[2/3] Scanning files (skipping ignored folders & non-code extensions)...`);
  const files = collectCodeFiles(repoPath, repoPath);
  console.log(`      Found ${files.length} code file(s) eligible for ingestion.`);

  // Clean up any files in database that were deleted from disk
  const existingDbFiles = await prisma.file.findMany({
    where: { repo_id: repo.id },
    select: { id: true, file_path: true }
  });
  const currentRelPaths = new Set(files.map((f) => f.relPath));
  const filesToDelete = existingDbFiles.filter((f) => !currentRelPaths.has(f.file_path));

  if (filesToDelete.length > 0) {
    await prisma.file.deleteMany({
      where: { id: { in: filesToDelete.map((f) => f.id) } }
    });
    console.log(`      Pruned ${filesToDelete.length} stale/deleted file(s) from database.`);
  }

  // ==========================================================
  // PASS 1: File Ingestion & Symbol Extraction
  // ==========================================================
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

    // Step 4 requirement: Delete any edges connected to old symbols before deleting symbols
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

  // ==========================================================
  // PASS 2: Dependency Graph Edge Extraction (symbol_edges)
  // ==========================================================
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

  // Summary Report
  console.log(`\n========================================`);
  console.log(` Ingestion Complete`);
  console.log(`========================================`);
  console.log(`Files Scanned              : ${filesScanned}`);
  console.log(`Files Processed (New)      : ${filesProcessed}`);
  console.log(`Files Skipped (Cached)     : ${filesSkipped}`);
  console.log(`Files Skipped (No Symbols) : ${filesNoSymbols}`);
  console.log(`Symbols Inserted           : ${symbolsInserted}`);
  if (symbolsInserted > 0) {
    console.log(`  - Functions              : ${symbolsByType.function}`);
    console.log(`  - Classes                : ${symbolsByType.class}`);
    console.log(`  - Methods                : ${symbolsByType.method}`);
  }
  console.log(`Edges Extracted (total)    : ${totalEdgesCount}`);
  console.log(`========================================\n`);
}

main()
  .catch((err) => {
    console.error("\n[FATAL ERROR during ingestion]:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
