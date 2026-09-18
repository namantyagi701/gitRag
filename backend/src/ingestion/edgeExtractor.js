const path = require("path");
const { getParserForExtension } = require("./astParsers");

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

module.exports = {
  extractImportsFromSource,
  resolveImportPath,
  findEnclosingSymbol,
  extractCallsFromSource
};
