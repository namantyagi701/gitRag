#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

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

// File extensions considered source code
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

/**
 * Compute SHA-256 hash of file content
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
 * Parse CLI arguments:
 * Supports:
 *   node src/scripts/ingest.js <path-to-repo> <owner> <name>
 *   node src/scripts/ingest.js <path-to-repo> <owner/name>
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

  // 3. Process files & insert dummy symbols
  console.log(`[3/3] Ingesting files and symbols...`);

  let filesScanned = 0;
  let filesSkipped = 0;
  let filesProcessed = 0;
  let symbolsInserted = 0;

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

    // Insert dummy symbol proving the write path works
    await prisma.symbol.create({
      data: {
        repo_id: repo.id,
        file_id: fileRecord.id,
        symbol_name: "TODO",
        symbol_type: "function",
        start_line: 1,
        end_line: 1,
        code_body: content.slice(0, 100),
        content_hash: contentHash
      }
    });

    symbolsInserted++;
    filesProcessed++;
  }

  // Summary Report
  console.log(`\n========================================`);
  console.log(` Ingestion Complete`);
  console.log(`========================================`);
  console.log(`Files Scanned          : ${filesScanned}`);
  console.log(`Files Processed (New)  : ${filesProcessed}`);
  console.log(`Files Skipped (Cached) : ${filesSkipped}`);
  console.log(`Symbols Inserted       : ${symbolsInserted}`);
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
