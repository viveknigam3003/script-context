import type * as monaco from "monaco-editor";
import { Parser, type Point, Tree, Node } from "web-tree-sitter";
import { ensureParser } from "./treeSitterInit";

type Position = { lineNumber: number; column: number };

export interface ContextOptions {
  // TODO: add prefix and suffix bifurcation
  /**
   * If no function / blocks are found, number of lines above and below to include.
   * Defaults to 5.
   */
  fallbackLineWindow?: number;
  /**
   * Level of context extraction for a given code block.
   * 0 => innermost function only (current behavior),
   * 1 => parent function, 2 => grandparent, etc.
   * Max level = 50;
   */
  nestingLevel?: number; // default 0
  /** Hard budget for fallback & sibling strategies (approx chars).
   * Default ~4k chars (~1k tokens).
   */
  maxCharsBudget?: number;
  tierPercents?: { A: number; B: number; C: number; D: number }; // defaults below
  includeLeadingComments?: boolean; // default true (you already do it)
}

const W_TITLE = 0.2; // boosts title/name overlap

export interface ExtractContextResult {
  /**
   * The full text slice to feed to the LLM.
   */
  text: string;
  /**
   * The 0-based start and end offsets (UTF-16 code units) in the model.
   * (Useful if you want to highlight the region in the editor.)
   */
  startOffset: number;
  endOffset: number;
  /**
   * What strategy was used to obtain this context.
   */
  strategy:
    | "enclosing-function"
    | "adjacent-top-level-blocks"
    | "fallback-lines";
}

// ---- Ranking model bits (NEW) ----
type BlockRange = {
  startOffset: number;
  endOffset: number;
  node: Node;
  kind?: string;
};

type RankedBlock = BlockRange & {
  sizeChars: number;
  signals: {
    lexical: number;
    reference: number;
    kind: number;
    complexity: number;
  };
  score: number;
};

const DEFAULT_TIER_PERCENTS = { A: 0.4, B: 0.3, C: 0.2, D: 0.1 } as const;

// Weights: tune via telemetry later
const W_LEX = 0.3;
const W_REF = 0.35; // a touch higher—dependencies matter a lot
const W_KIND = 0.2;
const W_COMP = -0.05; // gentle size penalty

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

export class ContextExtractor {
  private parser!: Parser;

  private tree: Tree | null = null;
  private dirty = true;
  private lastParseTime: number = 0;

  /**
   * We store pending incremental edits between parses.
   * Each edit mirrors the data Tree-sitter expects in .edit()
   */
  private pendingEdits: Array<{
    startIndex: number;
    oldEndIndex: number;
    newEndIndex: number;
    startPosition: Point;
    oldEndPosition: Point;
    newEndPosition: Point;
  }> = [];

  private model: monaco.editor.ITextModel;

  private constructor(model: monaco.editor.ITextModel) {
    this.model = model;
  }

  /**
   * Initialize Tree-sitter + language and return an instance bound to a Monaco model.
   *
   * @param model Monaco text model
   * @param wasmUrl URL for tree-sitter-javascript.wasm (must be served by your app)
   */
  static async create(
    model: monaco.editor.ITextModel
  ): Promise<ContextExtractor> {
    // Use the existing treeSitterInit module
    const parser = await ensureParser();

    const instance = new ContextExtractor(model);
    instance.parser = parser;

    // Initial parse
    instance.tree = instance.parser.parse(model.getValue());
    instance.dirty = false;
    instance.lastParseTime = Date.now();

    return instance;
  }

  /**
   * Get the current status of the AST tree
   */
  getTreeStatus() {
    return {
      isDirty: this.dirty,
      hasTree: !!this.tree,
      pendingEditsCount: this.pendingEdits.length,
      lastParseTime: this.lastParseTime,
    };
  }

  /**
   * Force rebuild the AST tree immediately
   */
  forceBuildTree() {
    this.ensureIncrementalParseUpToDate();
  }

  /**
   * Call this from Monaco's onDidChangeModelContent handler.
   * It records incremental edits; we only re-parse on demand.
   */
  onModelContentChanged(e: monaco.editor.IModelContentChangedEvent) {
    const changes = [...e.changes].sort(
      (a, b) => a.rangeOffset - b.rangeOffset
    );

    for (const change of changes) {
      // PRE-CHANGE positions (Monaco guarantees these are pre-change)
      const startPosition: Point = {
        row: change.range.startLineNumber - 1,
        column: change.range.startColumn - 1,
      };
      const oldEndPosition: Point = {
        row: change.range.endLineNumber - 1,
        column: change.range.endColumn - 1,
      };

      // PRE-CHANGE indices (use the event’s offsets, not model.getOffsetAt)
      const startIndex = change.rangeOffset;
      const oldEndIndex = change.rangeOffset + change.rangeLength;

      // POST-CHANGE indices and positions derived from inserted text length
      const newEndIndex = change.rangeOffset + change.text.length;
      const newEndPosition = this.advancePointByText(
        startPosition,
        change.text
      );

      this.pendingEdits.push({
        startIndex,
        oldEndIndex,
        newEndIndex,
        startPosition,
        oldEndPosition,
        newEndPosition,
      });
    }

    this.dirty = true;
  }

  // Add this helper somewhere private:
  private advancePointByText(start: Point, text: string): Point {
    // Count lines in the inserted text
    const norm = text.replace(/\r\n?/g, "\n"); // ← normalize
    const lines = norm.split("\n");
    if (lines.length === 1) {
      // single-line insert
      return { row: start.row, column: start.column + lines[0].length };
    }
    // multi-line insert
    const lastLine = lines[lines.length - 1];
    return {
      row: start.row + (lines.length - 1),
      column: lastLine.length,
    };
  }

  private wrapFunctionIfArgument(funcNode: Node): Node {
    let p: Node | null = funcNode.parent;
    while (p) {
      if (p.type === "call_expression" || p.type === "new_expression") return p;
      // Stop at root
      if (!p.parent) break;
      p = p.parent;
    }
    return funcNode;
  }

  private mergeRanges(
    ranges: Array<{ startOffset: number; endOffset: number }>
  ) {
    const sorted = ranges.slice().sort((a, b) => a.startOffset - b.startOffset);
    const out: typeof sorted = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (!last || r.startOffset >= last.endOffset) {
        out.push({ ...r });
      } else {
        last.endOffset = Math.max(last.endOffset, r.endOffset);
      }
    }
    return out;
  }

  /**
   * Returns a context slice based on cursor position following your rules:
   * 1) enclosing function if inside one
   * 2) else one top-level block above + one below
   * 3) else N lines around cursor
   */
  getContextAroundCursor(
    cursor: Position,
    opts: ContextOptions = {}
  ): ExtractContextResult {
    this.ensureIncrementalParseUpToDate();

    if (!this.tree) {
      // Shouldn't happen, but fallback gracefully
      return this.linesAround(cursor, opts.fallbackLineWindow ?? 5);
    }

    // Tree-sitter positions are 0-based {row, column}
    const tsPos: Point = {
      row: cursor.lineNumber - 1,
      column: cursor.column - 1,
    };

    const nodeAtCursor = this.tree.rootNode.descendantForPosition(tsPos);
    if (!nodeAtCursor) {
      return this.linesAround(cursor, opts.fallbackLineWindow ?? 5);
    }

    // 1) Try enclosing function-like block
    const innerFunc = this.nearestFunctionFrom(nodeAtCursor);
    if (innerFunc) {
      const nestingLevel = opts.nestingLevel ?? 0; // CHANGED: default to innermost
      const targetFunc = this.elevateFunctionByLevels(innerFunc, nestingLevel);

      // Keep the behavior: if the selected function is used as an argument,
      // wrap to the call/new expression so we don’t miss the closing parens.
      const container = this.wrapFunctionIfArgument(targetFunc);

      const { startOffset, endOffset } = this.expandNodeToFullLines(container);
      return {
        text: this.model.getValueInRange({
          startLineNumber: this.model.getPositionAt(startOffset).lineNumber,
          startColumn: 1,
          endLineNumber: this.model.getPositionAt(endOffset).lineNumber,
          endColumn: this.lineEndColumnAtOffset(endOffset),
        }),
        startOffset,
        endOffset,
        strategy: "enclosing-function",
      };
    }

    // 2) Else top-level siblings (one above, one below)
    const topLevel = this.topLevelAncestor(nodeAtCursor);
    if (topLevel) {
      const prev = this.previousNamedSibling(topLevel);
      const next = this.nextNamedSibling(topLevel);

      // Include the current top-level node too if asked
      const blocks: Array<{ startOffset: number; endOffset: number }> = [];
      const expand = (n: Node) =>
        opts.includeLeadingComments ?? true
          ? this.expandNodeToFullLinesWithLeadingComments(n)
          : this.expandNodeToFullLines(n);

      blocks.push(expand(topLevel));
      if (prev) blocks.push(expand(prev));
      if (next) blocks.push(expand(next));

      if (blocks.length > 0) {
        const merged = this.mergeRanges(blocks);
        const startOffset = merged[0].startOffset;
        const endOffset = merged[merged.length - 1].endOffset;

        return {
          text: this.model.getValueInRange({
            startLineNumber: this.model.getPositionAt(startOffset).lineNumber,
            startColumn: 1,
            endLineNumber: this.model.getPositionAt(endOffset).lineNumber,
            endColumn: this.lineEndColumnAtOffset(endOffset),
          }),
          startOffset,
          endOffset,
          strategy: "adjacent-top-level-blocks",
        };
      }
    }

    // 3) Else fallback lines around cursor
    return this.linesAround(
      cursor,
      opts.fallbackLineWindow ?? 5,
      opts.maxCharsBudget
    );
  }

  /** Apply pending edits and reparse incrementally if needed */
  private ensureIncrementalParseUpToDate() {
    if (!this.dirty) return;

    if (!this.tree) {
      this.tree = this.parser.parse(this.model.getValue());
      this.pendingEdits = [];
      this.dirty = false;
      this.lastParseTime = Date.now();
      return;
    }

    // Apply accumulated edits to the existing tree
    for (const e of this.pendingEdits) {
      this.tree.edit(e);
    }

    // Incremental reparse using existing tree
    this.tree = this.parser.parse(this.model.getValue(), this.tree);
    this.pendingEdits = [];
    this.dirty = false;
    this.lastParseTime = Date.now();
  }

  private isFunctionLike(n: Node | null): boolean {
    return (
      !!n &&
      (n.type === "function_declaration" ||
        n.type === "function_expression" ||
        n.type === "arrow_function" ||
        n.type === "method_definition" ||
        n.type === "generator_function" ||
        n.type === "class_method" ||
        n.type === "function")
    );
  }

  private isWholeBlockCandidate(n: Node): boolean {
    // Keep this focused on JS + your Postman scripts
    return (
      n.type === "function_declaration" ||
      n.type === "function_expression" ||
      n.type === "arrow_function" ||
      n.type === "method_definition" ||
      n.type === "generator_function" ||
      n.type === "class_declaration" ||
      n.type === "lexical_declaration" || // 👈 ADD THIS (const/let)
      n.type === "variable_declaration" || // var
      n.type === "expression_statement" || // e.g. pm.test(...)
      n.type === "if_statement" ||
      n.type === "for_statement" ||
      n.type === "for_in_statement" ||
      n.type === "for_of_statement" ||
      n.type === "while_statement" ||
      n.type === "do_statement" ||
      n.type === "try_statement" ||
      n.type === "switch_statement"
    );
  }

  /** Expand a top-level or statement node to its “container” we want to keep whole. */
  private wholeBlockContainer(n: Node): Node {
    // If it's a function used as an argument, prefer the enclosing call/new so we keep closing ')'
    if (this.isFunctionLike(n)) return this.wrapFunctionIfArgument(n);
    // If the statement is an expression_statement whose expression is a call (e.g., pm.test(...))
    if (n.type === "expression_statement" && n.namedChildren.length === 1) {
      const child = n.namedChildren[0];
      if (
        child &&
        (child.type === "call_expression" || child.type === "new_expression")
      ) {
        return child;
      }
    }
    return n;
  }

  /** Return whole-block ranges that intersect a line window, but only as full nodes (no slicing). */
  private collectWholeBlocksIntersectingWindow(
    startLine: number,
    endLine: number
  ): Array<{ startOffset: number; endOffset: number; node: Node }> {
    if (!this.tree) return [];
    const root = this.tree.rootNode;

    // Gather direct children (top-level statements) that intersect the window
    const results: Array<{
      startOffset: number;
      endOffset: number;
      node: Node;
    }> = [];

    for (let i = 0; i < root.namedChildCount; i++) {
      const child = root.namedChild(i)!;
      if (!this.isWholeBlockCandidate(child)) continue;

      const s = child.startPosition.row + 1;
      const e = child.endPosition.row + 1;

      // Intersect line window?
      if (e < startLine || s > endLine) continue;

      const container = this.wholeBlockContainer(child);
      const { startOffset, endOffset } =
        this.expandNodeToFullLinesWithLeadingComments(container); // 👈
      results.push({ startOffset, endOffset, node: container });
    }

    return results.sort((a, b) => a.startOffset - b.startOffset);
  }

  /** Pack whole blocks into a char budget (never cut). Keeps order, merges adjacency. */
  private packBlocksWithinBudget(
    blocks: Array<{ startOffset: number; endOffset: number }>,
    maxChars: number
  ): Array<{ startOffset: number; endOffset: number }> {
    const merged = this.mergeRanges(blocks); // you already have mergeRanges
    const packed: Array<{ startOffset: number; endOffset: number }> = [];
    let used = 0;

    for (const r of merged) {
      const size = r.endOffset - r.startOffset;
      if (size <= 0) continue;
      if (used + size > maxChars) break; // stop before over-budget
      packed.push(r);
      used += size;
    }
    return packed;
  }

  private isFunctionBody(n: Node | null): boolean {
    return !!n && (n.type === "statement_block" || n.type === "function_body");
  }

  private nearestFunctionFrom(node: Node): Node | null {
    let cur: Node | null = node;
    while (cur) {
      if (this.isFunctionLike(cur)) return cur;
      if (
        this.isFunctionBody(cur) &&
        cur.parent &&
        this.isFunctionLike(cur.parent)
      ) {
        return cur.parent;
      }
      if (cur.type === "arguments") {
        const fnArg = cur.namedChildren.find((c) => this.isFunctionLike(c));
        if (fnArg) return fnArg;
      }
      cur = cur.parent;
    }
    return null;
  }

  private elevateFunctionByLevels(funcNode: Node, levels: number): Node {
    if (levels <= 0) return funcNode;
    const safeLevels = Math.min(Math.max(levels, 0), 50);
    let current: Node = funcNode;

    for (let i = 0; i < safeLevels; i++) {
      // Walk up until we find the *next* outer function-like ancestor
      let p: Node | null = current.parent;
      let promoted: Node | null = null;

      while (p) {
        if (this.isFunctionLike(p)) {
          promoted = p;
          break;
        }
        // Also handle being inside a function body on the path upwards
        if (
          this.isFunctionBody(p) &&
          p.parent &&
          this.isFunctionLike(p.parent)
        ) {
          promoted = p.parent;
          break;
        }
        p = p.parent;
      }

      if (!promoted) break; // no more enclosing functions — stop early
      current = promoted;
    }

    return current;
  }

  /** Return the highest ancestor that is a direct child of the root (i.e., a top-level statement) */
  private topLevelAncestor(node: Node): Node | null {
    let cur: Node | null = node;
    let last: Node | null = node;
    while (cur && cur.parent) {
      last = cur;
      cur = cur.parent;
    }
    // If last is directly under root, it's top-level
    return last && last.parent === this.tree?.rootNode ? last : null;
  }

  private previousNamedSibling(node: Node): Node | null {
    let prev = node.previousNamedSibling;
    while (prev && prev.isMissing) prev = prev.previousNamedSibling;
    return prev ?? null;
  }

  private nextNamedSibling(node: Node): Node | null {
    let next = node.nextNamedSibling;
    while (next && next.isMissing) next = next.nextNamedSibling;
    return next ?? null;
  }

  private expandNodeToFullLinesWithLeadingComments(node: Node): {
    startOffset: number;
    endOffset: number;
  } {
    // Walk non-named siblings backward to include contiguous comments
    let startNode: Node = node;
    let p: Node | null = node.previousSibling;
    while (p && p.type === "comment") {
      // Only include comments that are directly adjacent (no blank line between)
      const commentEndLine = p.endPosition.row;
      const nodeStartLine = startNode.startPosition.row;
      if (commentEndLine + 1 === nodeStartLine) {
        startNode = p;
        p = p.previousSibling;
      } else {
        break;
      }
    }
    // Then do your normal full-line expansion
    return this.expandNodeToFullLines(startNode);
  }

  /** Expand a node to full-line boundaries (never cut lines) */
  private expandNodeToFullLines(node: Node): {
    startOffset: number;
    endOffset: number;
  } {
    // CHANGED: Use startPosition/endPosition instead of byte indexes & /2 conversion
    const startPosTS = node.startPosition; // { row, column }
    const endPosTS = node.endPosition; // { row, column }

    const fullStart = { lineNumber: startPosTS.row + 1, column: 1 };
    const fullEnd = {
      lineNumber: endPosTS.row + 1,
      column: this.lineEndColumn(endPosTS.row + 1),
    };

    const fullStartOffset = this.model.getOffsetAt(fullStart);
    const fullEndOffset = this.model.getOffsetAt(fullEnd);

    return { startOffset: fullStartOffset, endOffset: fullEndOffset };
  }

  /** Fallback: N lines above and below cursor, clamped to file bounds */
  /** Fallback: prefer whole blocks intersecting a small window; never cut. */
  private linesAround(
    cursor: Position,
    window: number,
    maxCharsBudget?: number
  ): ExtractContextResult {
    const totalLines = this.model.getLineCount();
    const startLine = Math.max(1, cursor.lineNumber - window);
    const endLine = Math.min(totalLines, cursor.lineNumber + window);

    // 1) Collect whole blocks that intersect the line window
    const blocks = this.collectWholeBlocksIntersectingWindow(
      startLine,
      endLine
    );

    // 2) If we found blocks, include them as whole nodes within budget
    const budget = Math.max(0, maxCharsBudget ?? 4000); // ~1k tokens by default
    if (blocks.length > 0) {
      const packed = this.packBlocksWithinBudget(
        blocks.map((b) => ({
          startOffset: b.startOffset,
          endOffset: b.endOffset,
        })),
        budget
      );
      if (packed.length > 0) {
        const merged = this.mergeRanges(packed);
        const startOffset = merged[0].startOffset;
        const endOffset = merged[merged.length - 1].endOffset;

        const text = this.model.getValueInRange({
          startLineNumber: this.model.getPositionAt(startOffset).lineNumber,
          startColumn: 1,
          endLineNumber: this.model.getPositionAt(endOffset).lineNumber,
          endColumn: this.lineEndColumnAtOffset(endOffset),
        });

        return { text, startOffset, endOffset, strategy: "fallback-lines" };
      }
    }

    // 3) If no whole block fits, return the *nearest* single statement (whole) if any
    //    This avoids returning syntactically broken snippets.
    const nodeAtCursor = this.tree!.rootNode.descendantForPosition({
      row: cursor.lineNumber - 1,
      column: cursor.column - 1,
    });
    if (nodeAtCursor) {
      // Try the nearest function; if none, nearest top-level statement
      const f = this.nearestFunctionFrom(nodeAtCursor);
      if (f) {
        const container = this.wrapFunctionIfArgument(f);
        const { startOffset, endOffset } =
          this.expandNodeToFullLines(container);
        const size = endOffset - startOffset;
        if (size <= budget) {
          const text = this.model.getValueInRange({
            startLineNumber: this.model.getPositionAt(startOffset).lineNumber,
            startColumn: 1,
            endLineNumber: this.model.getPositionAt(endOffset).lineNumber,
            endColumn: this.lineEndColumnAtOffset(endOffset),
          });
          return { text, startOffset, endOffset, strategy: "fallback-lines" };
        }
      }

      // Fall back to the cursor's top-level ancestor as a whole statement if it fits
      const top = this.topLevelAncestor(nodeAtCursor);
      if (top) {
        const { startOffset, endOffset } = this.expandNodeToFullLines(
          this.wholeBlockContainer(top)
        );
        const size = endOffset - startOffset;
        if (size <= budget) {
          const text = this.model.getValueInRange({
            startLineNumber: this.model.getPositionAt(startOffset).lineNumber,
            startColumn: 1,
            endLineNumber: this.model.getPositionAt(endOffset).lineNumber,
            endColumn: this.lineEndColumnAtOffset(endOffset),
          });
          return { text, startOffset, endOffset, strategy: "fallback-lines" };
        }
      }
    }

    // 4) As absolute last resort, return *just the current full line* (never mid-line).
    //    This keeps syntax valid (at least a complete line), even if not very useful.
    const startOffset = this.model.getOffsetAt({
      lineNumber: cursor.lineNumber,
      column: 1,
    });
    const endOffset = this.model.getOffsetAt({
      lineNumber: cursor.lineNumber,
      column: this.lineEndColumn(cursor.lineNumber),
    });
    const text = this.model.getValueInRange({
      startLineNumber: cursor.lineNumber,
      startColumn: 1,
      endLineNumber: cursor.lineNumber,
      endColumn: this.lineEndColumn(cursor.lineNumber),
    });
    return { text, startOffset, endOffset, strategy: "fallback-lines" };
  }

  private lineEndColumn(lineNumber: number): number {
    return this.model.getLineMaxColumn(lineNumber);
  }

  private lineEndColumnAtOffset(endOffset: number): number {
    const endPos = this.model.getPositionAt(endOffset);
    return this.lineEndColumn(endPos.lineNumber);
  }

  private getTestTitleFromNode(node: Node): string | null {
    // pm.test(<title>, <fn>)
    if (node.type !== "call_expression") return null;
    const callee = node.child(0);
    if (!(callee && callee.type === "member_expression")) return null;
    const obj = callee.child(0);
    const prop = callee.child(2);
    const isPmTest =
      obj?.type === "identifier" && obj.text === "pm" && prop?.text === "test";
    if (!isPmTest) return null;

    const args = node.childForFieldName("arguments");
    if (!args || args.namedChildCount === 0) return null;
    const a0 = args.namedChildren[0];
    if (!a0) return null;

    if (a0.type === "string" || a0.type === "template_string") {
      return (
        a0.text
          // strip quotes/backticks and simple interpolations
          ?.replace(/^['"`]/, "")
          ?.replace(/['"`]$/, "")
          ?.replace(/\$\{[^}]+\}/g, "") ?? null
      );
    }
    return null;
  }

  private tokenize(s: string | null | undefined): string[] {
    if (!s) return [];
    return s
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  // Identifiers read/called inside a node, minus those defined within the node itself
  private freeIdentifiersOf(node: Node): Set<string> {
    const reads = new Set<string>();
    const defs = new Set<string>();

    // collect defs inside the node (function names, declarators)
    const collectDefs = (n: Node) => {
      if (n.type === "function_declaration") {
        const nm = n.childForFieldName("name")?.text;
        if (nm) defs.add(nm);
      } else if (n.type === "variable_declarator") {
        const id = n.childForFieldName("name");
        if (id?.type === "identifier" && id.text) defs.add(id.text);
      }
      for (let i = 0; i < n.namedChildCount; i++) collectDefs(n.namedChild(i)!);
    };

    const collectReads = (n: Node) => {
      if (n.type === "identifier") {
        const parent = n.parent;
        const name = n.text;
        const isDefSite =
          (parent?.type === "variable_declarator" &&
            parent.firstNamedChild === n) ||
          (parent?.type === "function_declaration" &&
            parent.childForFieldName("name") === n);
        if (!isDefSite && name) reads.add(name);
      }
      for (let i = 0; i < n.namedChildCount; i++)
        collectReads(n.namedChild(i)!);
    };

    collectDefs(node);
    collectReads(node);

    // free = reads \ defs
    defs.forEach((d) => reads.delete(d));
    return reads;
  }

  // Map "name" -> BlockRange for resolvable globals
  private buildGlobalIndex(): Map<string, BlockRange> {
    const map = new Map<string, BlockRange>();
    const globals = this.collectGlobalBlockCandidates();
    for (const g of globals) {
      // function_declaration: take its name
      if (g.node.type === "function_declaration") {
        const nm = g.node.childForFieldName("name")?.text;
        if (nm) map.set(nm, g);
      }
      // lexical/variable declarations (simple id = ...)
      if (
        g.node.type === "lexical_declaration" ||
        g.node.type === "variable_declaration"
      ) {
        const visit = (n: Node) => {
          if (n.type === "variable_declarator") {
            const id = n.childForFieldName("name");
            if (id?.type === "identifier" && id.text) {
              map.set(id.text, g);
            }
          }
          for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i)!);
        };
        visit(g.node);
      }
    }
    return map;
  }

  // Add globals needed by selected blocks (one hop), without slicing or blowing the budget
  private expandWithDependencies(
    picked: BlockRange[],
    globalIndex: Map<string, BlockRange>,
    already: Array<{ startOffset: number; endOffset: number }>,
    budgetLeft: number
  ): Array<{ startOffset: number; endOffset: number }> {
    const out = [...already];
    const seen = new Set(out.map((r) => `${r.startOffset}:${r.endOffset}`));

    const tryAdd = (br: BlockRange) => {
      const key = `${br.startOffset}:${br.endOffset}`;
      if (seen.has(key)) return false;
      const sz = br.endOffset - br.startOffset;
      if (sz <= 0 || sz > budgetLeft) return false;
      out.push({ startOffset: br.startOffset, endOffset: br.endOffset });
      budgetLeft -= sz;
      seen.add(key);
      return true;
    };

    for (const b of picked) {
      const free = this.freeIdentifiersOf(b.node);
      for (const name of free) {
        const dep = globalIndex.get(name);
        if (dep) tryAdd(dep);
      }
    }
    return out;
  }

  // Ranking

  // Collect plain identifier names used inside a range (reads + calls) using POSITION overlap
  private collectIdentifiersInRange(startOffset: number, endOffset: number) {
    if (!this.tree)
      return { reads: new Set<string>(), calls: new Set<string>() };

    const rangeStartPos = this.model.getPositionAt(startOffset);
    const rangeEndPos = this.model.getPositionAt(endOffset);

    // Helper: node is outside [rangeStartPos, rangeEndPos] ?
    const outsideByPos = (n: Node) =>
      n.endPosition.row < rangeStartPos.lineNumber - 1 ||
      n.startPosition.row > rangeEndPos.lineNumber - 1;

    const reads = new Set<string>();
    const calls = new Set<string>();

    const walk = (n: Node) => {
      if (outsideByPos(n)) return;

      if (n.type === "identifier") {
        const parent = n.parent;
        // name via positions (safe for any encoding)
        const name = this.model.getValueInRange({
          startLineNumber: n.startPosition.row + 1,
          startColumn: n.startPosition.column + 1,
          endLineNumber: n.endPosition.row + 1,
          endColumn: n.endPosition.column + 1,
        });

        // treat as read unless it's the defining id of a declarator or function name
        const isDef =
          (parent?.type === "variable_declarator" &&
            parent.firstNamedChild === n) ||
          (parent?.type === "function_declaration" &&
            parent.firstNamedChild === n);

        if (!isDef && name) reads.add(name);

        // If parent is call_expression and this id is the callee, mark a call
        if (
          parent?.type === "call_expression" &&
          parent.child(0) === n &&
          name
        ) {
          calls.add(name);
        }
      }

      for (let i = 0; i < n.namedChildCount; i++) walk(n.namedChild(i)!);
    };

    walk(this.tree.rootNode);
    return { reads, calls };
  }

  // Definitions exported by a block (function names, const/let/var ids)
  private collectDefsForBlock(n: Node): Set<string> {
    const defs = new Set<string>();
    const add = (name?: string | null) => {
      if (name) defs.add(name);
    };

    // function declaration
    if (n.type === "function_declaration") {
      add(n.childForFieldName("name")?.text);
      return defs;
    }

    // call_expression / expression_statement contain no direct defs
    if (n.type === "call_expression" || n.type === "expression_statement") {
      return defs;
    }

    // lexical/variable declarations
    const visit = (node: Node) => {
      if (node.type === "variable_declarator") {
        // id can be identifier or pattern; we only support simple for now
        const id = node.childForFieldName("name");
        if (id?.type === "identifier") add(id.text);
      }
      for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i)!);
    };

    if (n.type === "lexical_declaration" || n.type === "variable_declaration") {
      visit(n);
      return defs;
    }

    // method/class names are rarely globals in Postman tests; skip for brevity
    return defs;
  }

  // Top-level globals: const/let/var + function declarations (exclude Tier A block later)
  private collectGlobalBlockCandidates(): BlockRange[] {
    if (!this.tree) return [];
    const out: BlockRange[] = [];
    const root = this.tree.rootNode;

    for (let i = 0; i < root.namedChildCount; i++) {
      const child = root.namedChild(i)!;
      if (!this.isWholeBlockCandidate(child)) continue;
      // globals we want: function_declaration, lexical_declaration, variable_declaration
      if (
        child.type === "function_declaration" ||
        child.type === "lexical_declaration" ||
        child.type === "variable_declaration"
      ) {
        const container = this.wholeBlockContainer(child);
        const { startOffset, endOffset } = (
          this.expandNodeToFullLinesWithLeadingComments ??
          this.expandNodeToFullLines
        ).call(this, container);
        out.push({ startOffset, endOffset, node: container, kind: child.type });
      }
    }
    return out;
  }

  // Other test call blocks (pm.test(...)) except Tier A
  private collectOtherTestBlocks(excludeRange?: {
    startOffset: number;
    endOffset: number;
  }): BlockRange[] {
    if (!this.tree) return [];
    const out: BlockRange[] = [];
    const root = this.tree.rootNode;

    for (let i = 0; i < root.namedChildCount; i++) {
      const st = root.namedChild(i)!;
      // either expression_statement→call_expression or direct call_expression
      let call: Node | null = null;
      if (
        st.type === "expression_statement" &&
        st.namedChildCount === 1 &&
        st.namedChildren[0]?.type === "call_expression"
      ) {
        call = st.namedChildren[0];
      } else if (st.type === "call_expression") {
        call = st;
      }
      if (!call) continue;

      // is pm.test(...) ? (best-effort: callee is member_expression with object 'pm' and property 'test')
      const callee = call.child(0);
      if (callee?.type === "member_expression") {
        const obj = callee.child(0);
        const prop = callee.child(2); // object '.' property
        const isPmTest =
          obj?.type === "identifier" &&
          obj.text === "pm" &&
          prop?.text === "test";
        if (!isPmTest) continue;
      } else {
        continue;
      }

      const container = call; // we already prefer call expression container for tests
      const { startOffset, endOffset } = (
        this.expandNodeToFullLinesWithLeadingComments ??
        this.expandNodeToFullLines
      ).call(this, container);

      // exclude Tier A
      if (
        excludeRange &&
        !(
          endOffset <= excludeRange.startOffset ||
          startOffset >= excludeRange.endOffset
        )
      ) {
        continue;
      }
      out.push({ startOffset, endOffset, node: container, kind: "pm_test" });
    }

    return out;
  }

  private lineNumberAtOffset(off: number): number {
    return this.model.getPositionAt(off).lineNumber;
  }

  private scoreCandidates(
    candidates: BlockRange[],
    tierA: { startOffset: number; endOffset: number; text: string },
    cursor: Position,
    tierBudgetChars: number,
    titleTokens: string[]
  ): RankedBlock[] {
    // Build read/call sets from Tier A to estimate dependency likelihood
    const { reads, calls } = this.collectIdentifiersInRange(
      tierA.startOffset,
      tierA.endOffset
    );

    const cursorLine = cursor.lineNumber;

    const ranked: RankedBlock[] = candidates.map((c) => {
      const size = Math.max(0, c.endOffset - c.startOffset);

      // S_lexical: distance in lines from cursor → normalize to [0..1] (closer is better)
      const startLine = this.lineNumberAtOffset(c.startOffset);
      const dist = Math.abs(startLine - cursorLine);
      const S_lex = clamp01(1 - dist / 200); // 200-line decay horizon

      // S_ref: defs ∩ (reads ∪ calls) with a tiny sigmoid
      const defs = this.collectDefsForBlock(c.node);
      let matches = 0;
      defs.forEach((d) => {
        if (reads.has(d) || calls.has(d)) matches++;
      });
      const S_ref = clamp01(1 - Math.exp(-matches)); // 0→0, 1→~0.63, 2→~0.86, 3→~0.95

      // S_kind: priors (globals/tests favored)
      let S_kind = 0.5;
      switch (c.kind) {
        case "function_declaration":
          S_kind = 1.0;
          break;
        case "lexical_declaration":
          S_kind = 0.9;
          break;
        case "variable_declaration":
          S_kind = 0.8;
          break;
        case "pm_test":
          S_kind = 0.7;
          break;
        default:
          S_kind = 0.6;
          break;
      }

      let titleOverlap = 0;
      const nameCandidates: string[] = [];

      if (c.node.type === "function_declaration") {
        const nm = c.node.childForFieldName("name")?.text;
        if (nm) nameCandidates.push(nm);
      } else {
        // variables: push first declared id if any
        const defs = this.collectDefsForBlock(c.node);
        defs.forEach((d) => nameCandidates.push(d));
      }

      // also look at first few reads inside the node
      const free = this.freeIdentifiersOf(c.node);
      for (const id of Array.from(free).slice(0, 5)) nameCandidates.push(id);

      const names = nameCandidates.map((s) => s.toLowerCase());
      for (const t of titleTokens) {
        if (names.some((nm) => nm.includes(t))) titleOverlap++;
      }
      const S_title = clamp01(titleOverlap / Math.max(1, titleTokens.length));

      // S_complexity: relative to tier budget (char heuristic)
      const S_comp = clamp01(size / Math.max(1, tierBudgetChars));

      const score =
        W_LEX * S_lex +
        W_REF * S_ref +
        W_KIND * S_kind +
        W_COMP * S_comp +
        W_TITLE * S_title;

      return {
        ...c,
        sizeChars: size,
        signals: {
          lexical: S_lex,
          reference: S_ref,
          kind: S_kind,
          complexity: S_comp,
        },
        score,
      };
    });

    // Higher score first; break ties by smaller size
    ranked.sort((a, b) => b.score - a.score || a.sizeChars - b.sizeChars);
    return ranked;
  }

  private selectWithinBudget<
    T extends { startOffset: number; endOffset: number }
  >(items: T[], maxChars: number): T[] {
    const out: T[] = [];
    let used = 0;
    for (const it of items) {
      const sz = it.endOffset - it.startOffset;
      if (sz <= 0) continue;
      if (used + sz > maxChars) continue; // never cut — skip
      out.push(it);
      used += sz;
    }
    return out;
  }

  private renderTestSkeleton(node: Node): string {
    // try to pull the test name: pm.test("Name", ...)
    const arg0 = node.childForFieldName("arguments")?.namedChildren?.[0];
    const lit =
      arg0 && (arg0.type === "string" || arg0.type === "template_string")
        ? arg0.text
        : '"test"';
    return `/* <|existing_tests|> pm.test(${lit}, function () { ... }); */`;
  }

  private deriveBudgets(
    totalChars: number,
    perc: { A: number; B: number; C: number; D: number } = DEFAULT_TIER_PERCENTS
  ) {
    const clamp = (n: number) => Math.max(0, Math.floor(n));
    const A = clamp(totalChars * perc.A);
    const B = clamp(totalChars * perc.B);
    const C = clamp(totalChars * perc.C);
    const D = clamp(totalChars * perc.D);
    return { A, B, C, D, total: A + B + C + D };
  }

  private buildFinalTextFromRanges(
    ranges: Array<{ startOffset: number; endOffset: number }>,
    totalBudget: number
  ) {
    const merged = this.mergeRanges(ranges);
    let used = 0;
    const parts: string[] = [];
    for (const r of merged) {
      const sz = r.endOffset - r.startOffset;
      if (sz <= 0) continue;
      if (used + sz > totalBudget) continue; // never cut blocks
      parts.push(
        this.model.getValueInRange({
          startLineNumber: this.model.getPositionAt(r.startOffset).lineNumber,
          startColumn: 1,
          endLineNumber: this.model.getPositionAt(r.endOffset).lineNumber,
          endColumn: this.lineEndColumnAtOffset(r.endOffset),
        })
      );
      used += sz;
    }
    const text = parts.join("\n");
    const startOffset = merged[0]?.startOffset ?? 0;
    const endOffset = merged[merged.length - 1]?.endOffset ?? 0;
    return { text, startOffset, endOffset };
  }

  /**
   * New entrypoint: returns the tiered, ranked context (Tier A + ranked B/C/D).
   * - Keeps your existing strategies for Tier A.
   * - Adds Globals (B) and Test skeletons/blocks (C), then Behavioral (D, TODO hook).
   */
  public getRankedContext(
    cursor: Position,
    opts: ContextOptions = {}
  ): ExtractContextResult {
    const totalBudget = Math.max(1000, opts.maxCharsBudget ?? 8000);
    const percents = opts.tierPercents ?? { A: 0.4, B: 0.3, C: 0.2, D: 0.1 };
    const budgets = this.deriveBudgets(totalBudget, percents);

    // Tier A (unchanged)
    const tierA = this.getContextAroundCursor(cursor, {
      ...opts,
      maxCharsBudget: budgets.A,
    });
    const baseRange = {
      startOffset: tierA.startOffset,
      endOffset: tierA.endOffset,
    };

    // If Tier A is pm.test, capture title tokens
    const nodeAtCursor = this.tree!.rootNode.descendantForPosition({
      row: cursor.lineNumber - 1,
      column: cursor.column - 1,
    });
    const aFunc = nodeAtCursor ? this.nearestFunctionFrom(nodeAtCursor) : null;
    const aContainer = aFunc ? this.wrapFunctionIfArgument(aFunc) : null;
    const title = aContainer ? this.getTestTitleFromNode(aContainer) : null;
    const titleTokens = this.tokenize(title);

    // Build global index (for dependency expansion)
    const globalIndex = this.buildGlobalIndex();

    // ---- Tier B: Globals (exclude overlap with A)
    const globals = this.collectGlobalBlockCandidates().filter(
      (b) =>
        b.endOffset <= baseRange.startOffset ||
        b.startOffset >= baseRange.endOffset
    );
    const rankedB = this.scoreCandidates(
      globals,
      { ...baseRange, text: tierA.text },
      cursor,
      budgets.B,
      /* pass */ titleTokens
    );
    const pickedB = this.selectWithinBudget(rankedB, budgets.B);

    // ---- Tier C: Other tests
    const others = this.collectOtherTestBlocks(baseRange);
    const rankedC = this.scoreCandidates(
      others,
      { ...baseRange, text: tierA.text },
      cursor,
      budgets.C,
      titleTokens
    );
    const pickedC = this.selectWithinBudget(rankedC, budgets.C);

    // ---- Dependency closure (one hop) using leftover in B+C budgets
    const rangesBC = [
      ...pickedB.map((b) => ({
        startOffset: b.startOffset,
        endOffset: b.endOffset,
      })),
      ...pickedC.map((b) => ({
        startOffset: b.startOffset,
        endOffset: b.endOffset,
      })),
    ];
    const usedBC = rangesBC.reduce(
      (s, r) => s + (r.endOffset - r.startOffset),
      0
    );
    const bcBudgetLeft = Math.max(0, budgets.B + budgets.C - usedBC);

    const depExpanded = this.expandWithDependencies(
      [...pickedB, ...pickedC],
      globalIndex,
      rangesBC,
      bcBudgetLeft
    );

    // ---- Final multi-chunk build (no widening!)
    const allRanges = [baseRange, ...depExpanded];
    const { text, startOffset, endOffset } = this.buildFinalTextFromRanges(
      allRanges,
      totalBudget
    );

    return { text, startOffset, endOffset, strategy: tierA.strategy };
  }
}
