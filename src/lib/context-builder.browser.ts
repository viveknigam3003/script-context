/* Minimal browser version using web-tree-sitter. */
import { ensureParser } from "./treeSitterInit";
import type { Node as SyntaxNode } from "web-tree-sitter";

export type Cursor = { line: number; column: number }; // 1-based

export type BuildContextOptions = {
  maxChars?: number;
  windowStatements?: number; // +/- statements when trimming; default 6
  windowLines?: number; // deprecated; maps to ~windowStatements if supplied
};

export type BuildContextInput = {
  source: string;
  cursor: Cursor;
  cacheKey?: string; // reserved for future use
};

export type BuildContextResult = {
  text: string;
  stats: {
    definitionsIncluded: number;
    blockChars: number;
    totalChars: number;
    capped: boolean;
  };
};

export async function buildContext(
  input: BuildContextInput,
  opts: BuildContextOptions = {}
): Promise<BuildContextResult> {
  const parser = await ensureParser();
  const { source } = input;
  const indexAt = toIndex(source, input.cursor);

  console.log("Debug: cursor position", input.cursor);
  console.log("Debug: cursor index", indexAt);
  console.log("Debug: character at cursor", source[indexAt]);

  const tree = parser.parse(source);
  if (!tree) {
    throw new Error("Failed to parse source code");
  }
  const root = tree.rootNode;

  const nodeAt = root.descendantForIndex(indexAt, indexAt);
  if (!nodeAt) {
    throw new Error("Could not find node at cursor position");
  }
  console.log("Debug: node at cursor", nodeAt.type, nodeText(source, nodeAt));

  // Find the enclosing function or test
  const testBody = findEnclosingPmTestBody(nodeAt, source);
  const functionBody = findEnclosingFunctionBody(nodeAt);
  const statementBlock = findEnclosingStatementBlock(nodeAt);

  // For context extraction, we want a broader view, not just the immediate block
  let contextBlock = testBody ?? functionBody ?? statementBlock ?? root;

  // If we found a test body or function body and it's empty/small,
  // expand to include the function definition and surrounding context
  if ((testBody || functionBody) && contextBlock) {
    const contextText = nodeText(source, contextBlock);
    if (contextText.trim().length < 50) {
      // Very small block, expand context
      // Find the function declaration that contains this body
      let func = contextBlock.parent;
      while (func && !isFunctionNode(func)) {
        func = func.parent;
      }
      if (func) {
        // Include the function and some surrounding context
        contextBlock = func.parent ?? func;
      }
    }
  }

  console.log("Debug: selected block type", contextBlock.type);
  console.log(
    "Debug: selected block text",
    nodeText(source, contextBlock).substring(0, 200) + "..."
  );

  // Use a window-based approach for better context
  const windowStatements = opts.windowStatements ?? 6;
  const maxChars = opts.maxChars ?? 2000;

  let text: string;

  if (contextBlock.type === "program") {
    // For program level, use window around cursor
    text = emitWindowAroundCursor(root, source, input.cursor, windowStatements);
  } else {
    // For specific blocks, include definitions + block context
    const allIds = collectIdentifiers(contextBlock, source);
    const locals = collectLocals(contextBlock, source);
    const freeIds = new Set<string>();
    for (const n of allIds) {
      if (!locals.has(n) && !GLOBALS.has(n) && !KEYWORDS.has(n)) freeIds.add(n);
    }

    const defIndex = buildDefinitionsIndex(root, source);
    const cutoff = contextBlock.startIndex;
    const defNodes: SyntaxNode[] = [];
    for (const n of freeIds) {
      const found = findNearestDef(defIndex, n, cutoff);
      if (found) defNodes.push(found);
    }

    console.log("Debug: definition nodes found", defNodes.length);
    console.log("Debug: free identifiers", Array.from(freeIds));

    // Create context with definitions + current block
    const parts: string[] = [];

    // Add definitions first
    if (defNodes.length > 0) {
      for (const defNode of defNodes) {
        const defText = nodeText(source, defNode);
        if (defText.trim().length > 0) {
          parts.push(defText);
        }
      }
    }

    // Add current block or window around cursor
    if (
      contextBlock.type === "statement_block" ||
      contextBlock.type === "function"
    ) {
      const windowText = emitBlockWindowByStatements(
        contextBlock,
        source,
        input.cursor,
        windowStatements
      );
      if (windowText.trim().length > 0) {
        parts.push(windowText);
      }
    } else {
      const blockText = nodeText(source, contextBlock);
      if (blockText.trim().length > 0) {
        parts.push(blockText);
      }
    }

    text = parts.filter((p) => p.trim().length > 0).join("\n\n");
  }

  console.log("Debug: final text", text);

  // Apply character limit if needed
  let capped = false;
  if (text.length > maxChars) {
    capped = true;
    text = text.substring(0, maxChars);
  }

  return {
    text,
    stats: {
      definitionsIncluded: 0, // We'll update this with actual count
      blockChars: contextBlock.endIndex - contextBlock.startIndex,
      totalChars: text.length,
      capped,
    },
  };
}

/* --------------- helpers (browser-safe) --------------- */

function toIndex(src: string, cursor: Cursor): number {
  const { line, column } = cursor;
  let curLine = 1,
    idx = 0;
  while (curLine < line && idx < src.length) {
    const nl = src.indexOf("\n", idx);
    if (nl === -1) break;
    idx = nl + 1;
    curLine++;
  }
  return idx + Math.max(0, column - 1);
}
function nodeText(src: string, n: SyntaxNode): string {
  return src.slice(n.startIndex, n.endIndex);
}
function nodeToSpan(n: SyntaxNode): [number, number] {
  return [n.startIndex, n.endIndex];
}
function spanEq(a: [number, number], b: [number, number]) {
  return a[0] === b[0] && a[1] === b[1];
}
function dedupeAndSortSpans(spans: Array<[number, number]>) {
  const out: Array<[number, number]> = [];
  spans
    .filter((span): span is [number, number] => Boolean(span))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .forEach((s) => {
      if (!out.some((u) => spanEq(u, s))) out.push(s);
    });
  return out;
}
function joinSpans(src: string, spans: Array<[number, number]>) {
  return spans.map((s) => src.slice(s[0], s[1])).join("\n\n");
}

function emitWindowAroundCursor(
  root: SyntaxNode,
  source: string,
  cursor: Cursor,
  windowStatements: number
): string {
  const statements = findTopLevelStatements(root);
  const cursorIndex = toIndex(source, cursor);

  // Find the statement that contains or is closest to the cursor
  let targetIndex = -1;
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    if (cursorIndex >= stmt.startIndex && cursorIndex <= stmt.endIndex) {
      targetIndex = i;
      break;
    }
    if (cursorIndex < stmt.startIndex) {
      targetIndex = i;
      break;
    }
  }

  if (targetIndex === -1 && statements.length > 0) {
    targetIndex = statements.length - 1;
  }

  if (targetIndex === -1) {
    return source; // No statements found, return whole source
  }

  const windowSize = Math.floor(windowStatements / 2);
  const start = Math.max(0, targetIndex - windowSize);
  const end = Math.min(statements.length, targetIndex + windowSize + 1);

  const windowStatementNodes = statements.slice(start, end);

  if (windowStatementNodes.length === 0) {
    return "{}";
  }

  const firstNode = windowStatementNodes[0];
  const lastNode = windowStatementNodes[windowStatementNodes.length - 1];

  return source.slice(firstNode.startIndex, lastNode.endIndex);
}

function findTopLevelStatements(root: SyntaxNode): SyntaxNode[] {
  const statements: SyntaxNode[] = [];

  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i);
    if (child && isStatementNode(child)) {
      statements.push(child);
    }
  }

  return statements;
}

function isStatementNode(node: SyntaxNode): boolean {
  return (
    node.type.includes("statement") ||
    node.type === "expression" ||
    node.type === "variable_declaration" ||
    node.type === "function_declaration" ||
    node.type === "class_declaration"
  );
}
function childFor(node: SyntaxNode, field: string): SyntaxNode | null {
  return node.childForFieldName?.(field) ?? null;
}
function isFunctionNode(n: SyntaxNode) {
  return (
    n.type === "function" ||
    n.type === "function_declaration" ||
    n.type === "function_expression" ||
    n.type === "arrow_function"
  );
}
function functionBody(fn: SyntaxNode): SyntaxNode | null {
  return childFor(fn, "body") ?? null;
}

function findEnclosingPmTestBody(
  node: SyntaxNode | null,
  src: string
): SyntaxNode | null {
  let cur: SyntaxNode | null = node;
  while (cur) {
    if (isFunctionNode(cur)) {
      const parent = cur.parent;
      if (parent && parent.type === "call_expression") {
        const callee = parent.child(0);
        const calleeText = callee ? nodeText(src, callee) : "";
        if (calleeText === "pm.test" || calleeText.endsWith(".test")) {
          const b = functionBody(cur);
          if (b) return b;
        }
      }
    }
    cur = cur.parent;
  }
  return null;
}
function findEnclosingFunctionBody(node: SyntaxNode | null): SyntaxNode | null {
  let cur: SyntaxNode | null = node;
  while (cur) {
    if (isFunctionNode(cur)) {
      const b = functionBody(cur);
      if (b) return b;
    }
    cur = cur.parent;
  }
  return null;
}
function findEnclosingStatementBlock(
  node: SyntaxNode | null
): SyntaxNode | null {
  let cur: SyntaxNode | null = node;
  while (cur) {
    if (cur.type === "statement_block" || cur.type === "program") return cur;
    cur = cur.parent;
  }
  return null;
}

function collectIdentifiers(scopeNode: SyntaxNode, src: string): Set<string> {
  const out = new Set<string>();
  const st: SyntaxNode[] = [scopeNode];
  while (st.length) {
    const n = st.pop()!;
    if (n.type === "identifier") out.add(nodeText(src, n));
    if (isFunctionNode(n) && n !== scopeNode) continue;
    for (let i = 0; i < n.namedChildCount; i++) st.push(n.namedChild(i)!);
  }
  return out;
}
function collectPatternBindings(
  node: SyntaxNode,
  src: string,
  out: Set<string>
) {
  if (node.type === "identifier") {
    out.add(nodeText(src, node));
    return;
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)!;
    if (c.type === "identifier") out.add(nodeText(src, c));
    else collectPatternBindings(c, src, out);
  }
}
function collectLocals(scopeNode: SyntaxNode, src: string): Set<string> {
  const out = new Set<string>();
  if (isFunctionNode(scopeNode)) {
    const params = childFor(scopeNode, "parameters");
    if (params) collectPatternBindings(params, src, out);
  }
  const st: SyntaxNode[] = [scopeNode];
  while (st.length) {
    const n = st.pop()!;
    if (n.type === "variable_declarator") {
      const id = childFor(n, "name") ?? n.child(0);
      if (id) collectPatternBindings(id, src, out);
    } else if (
      n.type === "function_declaration" ||
      n.type === "class_declaration"
    ) {
      const name = childFor(n, "name") ?? n.child(1);
      if (name && name.type === "identifier") out.add(nodeText(src, name));
    }
    if (isFunctionNode(n) && n !== scopeNode) continue;
    for (let i = 0; i < n.namedChildCount; i++) st.push(n.namedChild(i)!);
  }
  return out;
}

type DefRecord = { name: string; node: SyntaxNode; start: number; end: number };
type DefIndex = Map<string, DefRecord[]>;

function buildDefinitionsIndex(root: SyntaxNode, src: string): DefIndex {
  const idx: DefIndex = new Map();
  const push = (name: string, node: SyntaxNode) => {
    const rec: DefRecord = {
      name,
      node,
      start: node.startIndex,
      end: node.endIndex,
    };
    const arr = idx.get(name);
    if (arr) arr.push(rec);
    else idx.set(name, [rec]);
  };

  const st: SyntaxNode[] = [root];
  while (st.length) {
    const n = st.pop()!;
    if (n.type === "function_declaration") {
      const nm = childFor(n, "name") ?? n.child(1);
      if (nm && nm.type === "identifier") push(nodeText(src, nm), n);
    }
    if (n.type === "variable_declaration") {
      for (let i = 0; i < n.namedChildCount; i++) {
        const d = n.namedChild(i)!;
        if (d.type !== "variable_declarator") continue;
        const id = childFor(d, "name") ?? d.child(0);
        if (id) {
          const names = new Set<string>();
          collectPatternBindings(id, src, names);
          for (const nm of names) push(nm, n);
        }
      }
    }
    if (n.type === "assignment_expression") {
      const left = childFor(n, "left") ?? n.child(0);
      if (left && left.type === "identifier") {
        let emit: SyntaxNode = n;
        while (
          emit.parent &&
          emit.parent.type !== "program" &&
          !emit.type.endsWith("statement")
        ) {
          emit = emit.parent;
          if (emit.type.endsWith("statement")) break;
        }
        push(nodeText(src, left), emit);
      }
    }
    if (isFunctionNode(n)) continue;
    for (let i = 0; i < n.namedChildCount; i++) st.push(n.namedChild(i)!);
  }
  for (const [k, arr] of idx) {
    arr.sort((a, b) => a.start - b.start);
    idx.set(k, arr);
  }
  return idx;
}
function findNearestDef(
  idx: DefIndex,
  name: string,
  cutoff: number
): SyntaxNode | null {
  const arr = idx.get(name);
  if (!arr || arr.length === 0) return null;
  let lo = 0,
    hi = arr.length - 1,
    best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].end <= cutoff) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best >= 0 ? arr[best].node : null;
}

function toSignatureSpan(node: SyntaxNode, src: string): [number, number] {
  if (
    node.type === "function_declaration" ||
    node.type === "function_expression" ||
    node.type === "function"
  ) {
    const b = childFor(node, "body");
    if (b) return [node.startIndex, Math.min(node.endIndex, b.startIndex)];
    return nodeToSpan(node);
  }
  if (node.type === "variable_declaration") {
    const text = nodeText(src, node);
    const nl = text.indexOf("\n");
    if (nl >= 0) return [node.startIndex, node.startIndex + nl];
    const eq = text.indexOf("=");
    if (eq >= 0) return [node.startIndex, node.startIndex + eq + 1];
    return nodeToSpan(node);
  }
  return nodeToSpan(node);
}

function emitBlockWindowByStatements(
  block: SyntaxNode,
  src: string,
  cursor: Cursor,
  windowStmts: number
): string {
  console.log("Debug: emitBlockWindowByStatements block type:", block.type);

  if (block.type !== "statement_block" && block.type !== "program") {
    const result = src.slice(block.startIndex, block.endIndex);
    console.log("Debug: non-statement block result:", result);
    return result;
  }

  const stmts = directStatements(block);
  console.log("Debug: found statements:", stmts.length);

  if (stmts.length === 0) {
    const result = src.slice(block.startIndex, block.endIndex);
    console.log("Debug: empty statements block result:", result);
    return result;
  }

  const abs = toIndex(src, cursor);
  const curIdx = findStatementIndexContaining(stmts, abs);
  const from = Math.max(0, curIdx - windowStmts);
  const to = Math.min(stmts.length, curIdx + windowStmts + 1);

  console.log(
    "Debug: cursor statement index:",
    curIdx,
    "from:",
    from,
    "to:",
    to
  );

  const openSlice = blockOpenSlice(block, src);
  const closeSlice = blockCloseSlice(block, src);

  console.log("Debug: openSlice:", JSON.stringify(openSlice));
  console.log("Debug: closeSlice:", JSON.stringify(closeSlice));

  const parts: string[] = [];
  parts.push(openSlice);
  if (from > 0) parts.push("/* …omitted… */\n");
  for (let i = from; i < to; i++) {
    const s = stmts[i];
    const stmtText = src.slice(s.startIndex, s.endIndex);
    console.log("Debug: adding statement:", stmtText);
    parts.push(stmtText);
    if (!src.slice(s.endIndex - 1, s.endIndex).includes("\n")) parts.push("\n");
  }
  if (to < stmts.length) parts.push("/* …omitted… */\n");
  parts.push(closeSlice);

  const result = parts.join("");
  console.log("Debug: final emitBlockWindowByStatements result:", result);
  return result;
}

function directStatements(block: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < block.namedChildCount; i++)
    out.push(block.namedChild(i)!);
  return out;
}
function findStatementIndexContaining(
  stmts: SyntaxNode[],
  absIdx: number
): number {
  let best = 0;
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    if (absIdx >= s.startIndex && absIdx < s.endIndex) return i;
    if (absIdx >= s.endIndex) best = i;
  }
  return best;
}
function blockOpenSlice(block: SyntaxNode, src: string): string {
  if (block.type === "program") return "";
  const first = block.namedChild(0);
  if (first) return src.slice(block.startIndex, first.startIndex);
  return "{\n";
}
function blockCloseSlice(block: SyntaxNode, src: string): string {
  if (block.type === "program") return "";
  let i = block.endIndex - 1;
  while (i > block.startIndex && src[i] !== "}") i--;
  const from = i >= block.startIndex ? i : block.endIndex - 1;
  return src.slice(from, block.endIndex);
}

const GLOBALS = new Set<string>([
  "pm",
  "console",
  "JSON",
  "Math",
  "Date",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "require",
  "module",
  "exports",
  "process",
]);
const KEYWORDS = new Set<string>([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "await",
  "of",
]);
