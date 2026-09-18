/**
 * Ingestion pipeline constants and file extension configurations
 */

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

module.exports = {
  IGNORED_DIRS,
  CODE_EXTENSIONS,
  NON_SYMBOL_EXTENSIONS,
  SUPPORTED_SYMBOL_EXTENSIONS
};
