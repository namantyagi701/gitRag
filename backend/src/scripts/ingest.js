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
  // Ascend parent wrappers (export_statement, variable_declaration, etc.)
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

  // 3. Process files & extract symbols
  console.log(`[3/3] Ingesting files and extracting symbols via Tree-sitter...`);

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
