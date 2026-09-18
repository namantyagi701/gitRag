const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { IGNORED_DIRS, CODE_EXTENSIONS } = require("./constants");

/**
 * Compute SHA-256 hash of a string
 */
function computeHash(content) {
  // Normalize string input before hashing
  const normalized = typeof content === "string" ? content : String(content);
  return crypto.createHash("sha256").update(normalized).digest("hex");
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

module.exports = {
  computeHash,
  collectCodeFiles
};
