const Parser = require("tree-sitter");
const JavaScript = require("tree-sitter-javascript");
const TypeScript = require("tree-sitter-typescript");
const { computeHash } = require("./fileScanner");

// Initialize parsers for JS, TS, and TSX
const jsParser = new Parser();
jsParser.setLanguage(JavaScript);

const tsParser = new Parser();
tsParser.setLanguage(TypeScript.typescript);

const tsxParser = new Parser();
tsxParser.setLanguage(TypeScript.tsx);

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
  if (!content || typeof content !== "string") {
    return [];
  }
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

module.exports = {
  getParserForExtension,
  extractPrecedingComment,
  extractSymbolsFromSource
};
