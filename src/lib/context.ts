import type * as monaco from "monaco-editor";
import { Parser, type Point, Tree, Node } from "web-tree-sitter";
import { ensureParser } from "./treeSitterInit";
import CODE_STOPWORDS from "./stopwords";

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

export interface RankedSectionsOptions extends ContextOptions {
  /** Emit rich debug info about ranking/selection. */
  debug?: boolean;
}

export type DebugInfo = {
  titleTokens: string[];
  queryTokens: string[];
  budgets: { A: number; B: number; C: number; D: number; total: number };
  scored: {
    B: RankedBlock[];
    C: RankedBlock[];
  };
  picked: {
    B: RankedBlock[];
    C: RankedBlock[];
  };
  skipped: {
    B: Array<{
      block: RankedBlock;
      reason: "over_budget" | "overlap_A" | "tie_break";
    }>;
    C: Array<{
      block: RankedBlock;
      reason: "over_budget" | "overlap_A" | "tie_break";
    }>;
  };
  depsAdded: Array<{ name: string; startOffset: number; endOffset: number }>;
};

export interface ExtractRankedContextSections {
  /** Tier A */
  linesAroundCursor: string; // the local/test block (Tier A)
  /** Tier B (+ dependency one-hop) */
  declarations: string; // selected globals/const/let/var & pulled deps
  /** Tier C (title-matched helpers or small glue picked as "most relevant") */
  relevantLines: string; // small non-global helpers that made the cut (optional)
  /** Other existing tests chosen for context or compact skeletons for skipped ones */
  existingTests: string; // other pm.test(...) blocks or skeletons
  /** Metadata + offsets to highlight */
  meta: {
    strategy: ExtractContextResult["strategy"];
    budgets: { A: number; B: number; C: number; D: number; total: number };
    offsets: {
      A: Array<{ startOffset: number; endOffset: number }>;
      B: Array<{ startOffset: number; endOffset: number }>;
      C: Array<{ startOffset: number; endOffset: number }>;
      D: Array<{ startOffset: number; endOffset: number }>;
    };
    pickedCounts: {
      A: number;
      B: number;
      C: number;
      D: number;
      skeletons: number;
    };
    titleTokens: string[];
  };
  /** Optional debug payload with rankings, signals, and reasons. */
  debug?: DebugInfo;
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

// Treat these as "top-level block kinds" for similarity and display
type TopBlockKind =
  | "pm_test"
  | "function_declaration"
  | "arrow_function_decl" // const x = () => {}
  | "function_expression_decl" // const x = function () {}
  | "lexical_declaration" // const/let (non-fn)
  | "variable_declaration"; // var (non-fn)

type TopBlock = {
  kind: TopBlockKind;
  node: Node;
  startOffset: number;
  endOffset: number;
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

function splitCamelSnake(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\W]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function cutTokenize(
  raw: string,
  STOP: Set<string> = CODE_STOPWORDS
): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const w of splitCamelSnake(raw.toLowerCase())) {
    if (w.length <= 1) continue;
    if (STOP.has(w)) continue;
    out.push(w);
  }
  // dedupe while preserving order
  const seen = new Set<string>();
  const dedup: string[] = [];
  for (const t of out) {
    if (!seen.has(t)) {
      seen.add(t);
      dedup.push(t);
    }
  }
  return dedup;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  // iterate smaller for perf
  const small = a.size <= b.size ? a : b;
  const big = a.size <= b.size ? b : a;
  small.forEach((t) => big.has(t) && inter++);
  return inter / (a.size + b.size - inter);
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

  private _lastDebug: DebugInfo | null = null;

  public getLastDebug(): DebugInfo | null {
    return this._lastDebug;
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
    // Find the first contiguous leading //-comment line (no blank line in between)
    let startNode: Node = node;
    let p: Node | null = node.previousSibling;
    while (p && p.type === "comment") {
      const commentEndLine = p.endPosition.row;
      const nodeStartLine = startNode.startPosition.row;
      if (commentEndLine + 1 === nodeStartLine) {
        startNode = p;
        p = p.previousSibling;
      } else {
        break;
      }
    }

    // Start = full line of the (possibly) earliest comment,
    // End   = full line of the original node
    const startPos = { lineNumber: startNode.startPosition.row + 1, column: 1 };
    const endPos = {
      lineNumber: node.endPosition.row + 1,
      column: this.lineEndColumn(node.endPosition.row + 1),
    };
    return {
      startOffset: this.model.getOffsetAt(startPos),
      endOffset: this.model.getOffsetAt(endPos),
    };
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
        const { startOffset, endOffset } =
          this.expandNodeToFullLinesWithLeadingComments(container);

        // Normalize kinds for consistent exclusion logic
        let kind = child.type;
        if (
          child.type === "lexical_declaration" ||
          child.type === "variable_declaration"
        ) {
          kind = "declaration";
        }

        out.push({ startOffset, endOffset, node: container, kind });
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
      const { startOffset, endOffset } =
        this.expandNodeToFullLinesWithLeadingComments(container);

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
      } else if (c.kind === "pm_test") {
        const t = this.getTestTitleFromNode(c.node);
        if (t) nameCandidates.push(...cutTokenize(t)); // <-- add this
      } else {
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
    return `pm.test(${lit}, function () { ... });`;
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

  private textFromRanges(
    ranges: Array<{ startOffset: number; endOffset: number }>
  ): string {
    const parts: string[] = [];
    for (const r of ranges) {
      if (r.endOffset <= r.startOffset) continue;
      parts.push(
        this.model.getValueInRange({
          startLineNumber: this.model.getPositionAt(r.startOffset).lineNumber,
          startColumn: 1,
          endLineNumber: this.model.getPositionAt(r.endOffset).lineNumber,
          endColumn: this.lineEndColumnAtOffset(r.endOffset),
        })
      );
    }
    return parts.join("\n");
  }

  private getLineText(lineNumber: number): string {
    return this.model.getLineContent(
      Math.max(1, Math.min(lineNumber, this.model.getLineCount()))
    );
  }

  // Pull contiguous single-line comments immediately above a node/line
  private leadingCommentTextAt(lineNumber: number): string {
    let startLine = Math.max(1, lineNumber - 1);
    while (startLine > 0) {
      const txt = this.model.getLineContent(startLine);
      if (/^\s*\/\/.*/.test(txt) || /^\s*$/.test(txt)) {
        startLine--;
        continue;
      }
      break;
    }
    const from = startLine + 1,
      to = Math.max(1, lineNumber - 1);
    const parts: string[] = [];
    for (let ln = from; ln <= to; ln++) {
      const t = this.model.getLineContent(ln).replace(/^\s*\/\/\s?/, "");
      if (t.trim().length) parts.push(t);
    }
    return parts.join(" ");
  }

  // Title from pm.test call around cursor (you already have getTestTitleFromNode)
  private getTestTitleNearCursor(cursor: Position): string | null {
    if (!this.tree) return null;
    const nodeAt = this.tree.rootNode.descendantForPosition({
      row: cursor.lineNumber - 1,
      column: cursor.column - 1,
    });
    const fn = nodeAt ? this.nearestFunctionFrom(nodeAt) : null;
    const call = fn ? this.wrapFunctionIfArgument(fn) : null;
    return call ? this.getTestTitleFromNode(call) : null;
  }

  // Final query tokens used for similarity search
  private buildQueryTokens(cursor: Position): string[] {
    const line = this.getLineText(cursor.lineNumber);
    const cmt = this.leadingCommentTextAt(cursor.lineNumber);
    const title = this.getTestTitleNearCursor(cursor) ?? "";
    return [...cutTokenize(line), ...cutTokenize(cmt), ...cutTokenize(title)];
  }

  private getNameAndLeadingCommentTokens(n: Node): string[] {
    const names: string[] = [];

    // 1) Function / variable name
    if (n.type === "function_declaration") {
      const nm = n.childForFieldName("name")?.text ?? "";
      if (nm) names.push(nm);
    } else if (
      n.type === "lexical_declaration" ||
      n.type === "variable_declaration"
    ) {
      // first identifier on the LHS
      let firstId = "";
      const walk = (node: Node) => {
        if (firstId) return;
        if (node.type === "identifier") {
          firstId = node.text ?? "";
          return;
        }
        for (let i = 0; i < node.namedChildCount; i++)
          walk(node.namedChild(i)!);
      };
      walk(n);
      if (firstId) names.push(firstId);
    }

    // 2) Leading comment text
    const startLine = n.startPosition.row + 1;
    const cmt = this.leadingCommentTextAt(startLine);

    // 3) A few body identifiers + string literal words (bounded for latency)
    const bodyTokens: string[] = [];
    const limitIds = 20; // small cap to keep this O(1)
    let seen = 0;

    const collectBody = (node: Node) => {
      if (seen >= limitIds) return;

      if (node.type === "identifier") {
        const txt = node.text ?? "";
        if (txt) {
          bodyTokens.push(txt);
          seen++;
        }
      } else if (node.type === "string" || node.type === "template_string") {
        // pull words from literals to help with semantics like "schema", "valid", etc.
        const raw = this.model.getValueInRange({
          startLineNumber: node.startPosition.row + 1,
          startColumn: node.startPosition.column + 1,
          endLineNumber: node.endPosition.row + 1,
          endColumn: node.endPosition.column + 1,
        });
        bodyTokens.push(
          ...splitCamelSnake(raw.replace(/^['"`]/, "").replace(/['"`]$/, ""))
        );
      }

      for (let i = 0; i < node.namedChildCount && seen < limitIds; i++) {
        collectBody(node.namedChild(i)!);
      }
    };

    // walk the node to sample tokens
    collectBody(n);

    // tokenize + stopword filter
    return [
      ...cutTokenize(names.join(" ")),
      ...cutTokenize(cmt),
      ...cutTokenize(bodyTokens.join(" ")),
    ];
  }

  // @ts-expect-error - Will be removed in next iteration
  private scoreHelperSimilarity(queryTokens: string[], n: Node): number {
    const q = new Set(queryTokens);
    const cands = new Set(this.getNameAndLeadingCommentTokens(n));
    const base = jaccard(q, cands); // 0..1
    // tiny bonus if any exact name token overlaps a query token
    let exact = 0;
    cands.forEach((t) => {
      if (q.has(t)) exact++;
    });
    const exactBoost = Math.min(0.15, exact * 0.03);
    // tiny bonus if helper mentions any free identifier from Tier A
    // (we’ll pass freeA externally to avoid re-traversal)
    return Math.min(1, base + exactBoost);
  }

  // Collect **all** top-level blocks we care about (functions, arrow-fn decls, pm.test, other decls)
  private collectTopLevelBlocks(): TopBlock[] {
    if (!this.tree) return [];
    const root = this.tree.rootNode;
    const blocks: TopBlock[] = [];

    const push = (node: Node, kind: TopBlockKind) => {
      const { startOffset, endOffset } =
        this.expandNodeToFullLinesWithLeadingComments(node);
      blocks.push({ kind, node, startOffset, endOffset });
    };

    for (let i = 0; i < root.namedChildCount; i++) {
      const st = root.namedChild(i)!;

      // pm.test(...) as expression or direct call
      const asCall =
        st.type === "expression_statement" ? st.namedChildren[0] : st;
      if (asCall?.type === "call_expression") {
        const callee = asCall.child(0);
        if (callee?.type === "member_expression") {
          const obj = callee.child(0);
          const prop = callee.child(2);
          if (
            obj?.type === "identifier" &&
            obj.text === "pm" &&
            prop?.text === "test"
          ) {
            push(asCall, "pm_test");
            continue;
          }
        }
      }

      // function declaration
      if (st.type === "function_declaration") {
        push(st, "function_declaration");
        continue;
      }

      // const/let/var (detect arrow/function initializer vs plain decl)
      if (
        st.type === "lexical_declaration" ||
        st.type === "variable_declaration"
      ) {
        let hasArrow = false;
        let hasFuncExpr = false;
        const walk = (n: Node) => {
          if (n.type === "arrow_function") hasArrow = true;
          if (n.type === "function_expression" || n.type === "function")
            hasFuncExpr = true;
          for (let j = 0; j < n.namedChildCount; j++) walk(n.namedChild(j)!);
        };
        walk(st);
        if (hasArrow) push(st, "arrow_function_decl");
        else if (hasFuncExpr) push(st, "function_expression_decl");
        else push(st, st.type as TopBlockKind);
        continue;
      }
    }

    blocks.sort((a, b) => a.startOffset - b.startOffset);
    return blocks;
  }

  // Get the visible text for a range
  private textForRange(startOffset: number, endOffset: number): string {
    return this.model.getValueInRange({
      startLineNumber: this.model.getPositionAt(startOffset).lineNumber,
      startColumn: 1,
      endLineNumber: this.model.getPositionAt(endOffset).lineNumber,
      endColumn: this.lineEndColumnAtOffset(endOffset),
    });
  }

  // Build cut tokens for a top-level block: leading comment + pm.test title + body
  // Build cut tokens for a top-level block: leading comment + name/ids + (pm.test title)
  private tokensForTopBlock(b: TopBlock): string[] {
    const base = this.getNameAndLeadingCommentTokens(b.node); // names + leading comment + sampled body ids
    let titleTokens: string[] = [];

    if (b.kind === "pm_test") {
      const args = b.node.childForFieldName("arguments");
      const a0 = args?.namedChildren?.[0];
      if (a0 && (a0.type === "string" || a0.type === "template_string")) {
        const title = a0.text.replace(/^['"`]/, "").replace(/['"`]$/, "");
        titleTokens = cutTokenize(title);
      }
    }

    // de-dupe while preserving order
    const seen = new Set<string>();
    const all = [...base, ...titleTokens];
    const out: string[] = [];
    for (const t of all)
      if (!seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    return out;
  }

  // Tokens around the current edit: nearest function (with leading comment) else current line + its comment
  private tokensForCurrentEdit(cursor: Position): {
    tokens: string[];
    range: { startOffset: number; endOffset: number };
  } {
    if (!this.tree)
      return { tokens: [], range: { startOffset: 0, endOffset: 0 } };

    const pos: Point = {
      row: cursor.lineNumber - 1,
      column: cursor.column - 1,
    };
    const nodeAt = this.tree.rootNode.descendantForPosition(pos);

    const isFn = (n: Node | null) =>
      !!n &&
      (n.type === "function_declaration" ||
        n.type === "function_expression" ||
        n.type === "arrow_function" ||
        n.type === "method_definition" ||
        n.type === "function");

    let fn: Node | null = nodeAt;
    while (fn && !isFn(fn)) fn = fn.parent;

    if (fn) {
      const { startOffset, endOffset } =
        this.expandNodeToFullLinesWithLeadingComments(fn);
      const cmt = this.leadingCommentTextAt(fn.startPosition.row + 1);
      const body = this.textForRange(startOffset, endOffset);
      return {
        tokens: cutTokenize([cmt, body].join(" \n ")),
        range: { startOffset, endOffset },
      };
    }

    const lineText = this.getLineText(cursor.lineNumber);
    const cmt = this.leadingCommentTextAt(cursor.lineNumber);
    const startOffset = this.model.getOffsetAt({
      lineNumber: cursor.lineNumber,
      column: 1,
    });
    const endOffset = this.model.getOffsetAt({
      lineNumber: cursor.lineNumber,
      column: this.lineEndColumn(cursor.lineNumber),
    });
    return {
      tokens: cutTokenize([cmt, lineText].join(" \n ")),
      range: { startOffset, endOffset },
    };
  }

  // Rank *all* other top-level blocks by Jaccard to current edit; return top K (no overlap with current)
  // Return ALL scored blocks; let caller filter and slice
  private rankSimilarTopBlocks(
    cursor: Position
  ): Array<{ block: TopBlock; score: number }> {
    const all = this.collectTopLevelBlocks();
    const { tokens: qTokens, range: qRange } =
      this.tokensForCurrentEdit(cursor);
    const qSet = new Set(qTokens);

    const scored = all
      .filter(
        (b) =>
          b.endOffset <= qRange.startOffset || b.startOffset >= qRange.endOffset
      )
      .map((b) => {
        const tks = this.tokensForTopBlock(b);
        const score = jaccard(qSet, new Set(tks));
        return { block: b, score };
      });

    // Prefer higher similarity, then closer to cursor
    const lineAt = (off: number) => this.model.getPositionAt(off).lineNumber;
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const da = Math.abs(lineAt(a.block.startOffset) - cursor.lineNumber);
      const db = Math.abs(lineAt(b.block.startOffset) - cursor.lineNumber);
      return da - db;
    });

    return scored;
  }

  private keyOf(r: { startOffset: number; endOffset: number }) {
    return `${r.startOffset}:${r.endOffset}`;
  }
  private overlaps(
    a: { startOffset: number; endOffset: number },
    b: { startOffset: number; endOffset: number }
  ) {
    return !(a.endOffset <= b.startOffset || a.startOffset >= b.endOffset);
  }
  private filterNonOverlapping<
    T extends { startOffset: number; endOffset: number }
  >(items: T[], taken: Array<{ startOffset: number; endOffset: number }>) {
    return items.filter((it) => !taken.some((t) => this.overlaps(it, t)));
  }

  private classRangeTaken: Array<{ startOffset: number; endOffset: number }> =
    [];

  private reserveRanges(
    ranges: Array<{ startOffset: number; endOffset: number }>
  ) {
    for (const r of ranges)
      this.classRangeTaken.push({
        startOffset: r.startOffset,
        endOffset: r.endOffset,
      });
  }

  private resetRangeReservations() {
    this.classRangeTaken = [];
  }

  public getRankedContextSections(
    cursor: Position,
    opts: RankedSectionsOptions = {}
  ): ExtractRankedContextSections {
    this.resetRangeReservations();

    const totalBudget = Math.max(1000, opts.maxCharsBudget ?? 8000);
    const percents = opts.tierPercents ?? DEFAULT_TIER_PERCENTS;
    const budgets = this.deriveBudgets(totalBudget, percents);

    const debug: DebugInfo = {
      titleTokens: [],
      queryTokens: [],
      budgets: { ...budgets, total: totalBudget },
      scored: { B: [], C: [] },
      picked: { B: [], C: [] },
      skipped: { B: [], C: [] },
      depsAdded: [],
    };

    // ---- Tier A (always exactly one slice) ----
    const tierA = this.getContextAroundCursor(cursor, {
      ...opts,
      maxCharsBudget: budgets.A,
    });
    const baseRange = {
      startOffset: tierA.startOffset,
      endOffset: tierA.endOffset,
    };
    const linesAroundCursorRanges = [baseRange];
    this.reserveRanges(linesAroundCursorRanges); // reserve A

    // Title / query tokens
    const nodeAtCursor = this.tree!.rootNode.descendantForPosition({
      row: cursor.lineNumber - 1,
      column: cursor.column - 1,
    });
    const aFunc = nodeAtCursor ? this.nearestFunctionFrom(nodeAtCursor) : null;
    const aContainer = aFunc ? this.wrapFunctionIfArgument(aFunc) : null;
    const title = aContainer ? this.getTestTitleFromNode(aContainer) : null;
    const titleTokens = this.tokenize(title);
    const queryTokens = this.buildQueryTokens(cursor);
    debug.titleTokens = titleTokens;
    debug.queryTokens = queryTokens;

    // Globals index (for later dep-closure)
    const globalIndex = this.buildGlobalIndex();

    // ---- Tier B: Declarations (NO overlap with A) ----
    const declOnly = this.collectGlobalBlockCandidates()
      .filter((b) => b.kind === "declaration")
      .filter(
        (b) =>
          b.endOffset <= baseRange.startOffset ||
          b.startOffset >= baseRange.endOffset
      );

    const rankedB = this.scoreCandidates(
      declOnly,
      { ...baseRange, text: tierA.text },
      cursor,
      budgets.B,
      titleTokens
    );
    debug.scored.B = rankedB;

    // ensure disjointness w/ A (already filtered) and within budget
    const pickedB = this.selectWithinBudget(
      this.filterNonOverlapping(rankedB, this.classRangeTaken),
      budgets.B
    );
    debug.picked.B = pickedB;
    const pickedBKeys = new Set(pickedB.map((b) => this.keyOf(b)));
    for (const r of rankedB)
      if (!pickedBKeys.has(this.keyOf(r)))
        debug.skipped.B.push({ block: r, reason: "over_budget" });
    this.reserveRanges(pickedB); // reserve B

    // ---- Tier C: Relevant helpers (cut-token similarity) ----
    const TOP_K = 3;

    // exclude Tier A range, all non-function declarations, and all pm.tests
    const testsAll = this.collectOtherTestBlocks();
    const excludeRanges = [baseRange, ...declOnly, ...testsAll];

    const overlapsExcluded = (r: { startOffset: number; endOffset: number }) =>
      excludeRanges.some(
        (ex) =>
          !(r.endOffset <= ex.startOffset || r.startOffset >= ex.endOffset)
      );

    // use the full ranked list; keep only helper functions
    const similarAll = this.rankSimilarTopBlocks(cursor)
      .filter(
        (s) =>
          s.block.kind === "function_declaration" ||
          s.block.kind === "arrow_function_decl" ||
          s.block.kind === "function_expression_decl"
      )
      .filter((s) => !overlapsExcluded(s.block));

    // now slice to K and enforce budget (never cut)
    const pickedC = this.selectWithinBudget(
      similarAll.map((s) => s.block),
      budgets.C
    ).slice(0, TOP_K);

    this.reserveRanges(pickedC); // reserve C

    // ---- One-hop dependency closure only for B + C (never re-add A or duplicates) ----
    const rangesBC = [
      ...pickedB.map((b) => ({
        startOffset: b.startOffset,
        endOffset: b.endOffset,
      })),
      ...pickedC.map((c) => ({
        startOffset: c.startOffset,
        endOffset: c.endOffset,
      })),
    ];
    const usedBC = rangesBC.reduce(
      (s, r) => s + (r.endOffset - r.startOffset),
      0
    );
    const bcBudgetLeft = Math.max(0, budgets.B + budgets.C - usedBC);

    const depExpanded = this.expandWithDependencies(
      [
        ...pickedB.map((b) => b as BlockRange),
        ...pickedC.map(
          (c) => ({ ...c, node: c.node } as unknown as BlockRange)
        ),
      ],
      globalIndex,
      rangesBC,
      bcBudgetLeft
    )
      // ensure we never add A or overlap with picked B/C
      .filter((r) => !this.overlaps(r, baseRange))
      .filter(
        (r) =>
          this.filterNonOverlapping([r], [...pickedB, ...pickedC]).length > 0
      );

    // ---- Tier D: Existing tests as skeletons (disjoint by *kind* from C) ----
    // Because we filtered pm_test out of C, all tests live here as skeletons, excluding Tier A.
    const testsExA = this.collectOtherTestBlocks(baseRange);
    const existingTests = testsExA.length
      ? testsExA.map((t) => this.renderTestSkeleton(t.node)).join("\n")
      : "";

    // ---- Build final strings ----
    const linesAroundCursor = this.textFromRanges(linesAroundCursorRanges);

    // Declarations = pickedB + any dep-expanded that are declarations
    const declRanges = [
      ...pickedB.map((b) => ({
        startOffset: b.startOffset,
        endOffset: b.endOffset,
      })),
      ...depExpanded.filter((r) =>
        declOnly.some(
          (g) => g.startOffset === r.startOffset && g.endOffset === r.endOffset
        )
      ),
    ];
    const declarations = this.textFromRanges(declRanges);

    const relevantRanges = pickedC.map((r) => ({
      startOffset: r.startOffset,
      endOffset: r.endOffset,
    }));
    const relevantLines = this.textFromRanges(relevantRanges);

    // ---- Emit ----
    const res: ExtractRankedContextSections = {
      linesAroundCursor,
      declarations,
      relevantLines,
      existingTests,
      meta: {
        strategy: tierA.strategy,
        budgets,
        offsets: {
          A: linesAroundCursorRanges,
          B: declRanges,
          C: relevantRanges,
          D: [], // skeletons are synthetic
        },
        pickedCounts: {
          A: 1,
          B: declRanges.length,
          C: relevantRanges.length,
          D: testsExA.length,
          skeletons: testsExA.length,
        },
        titleTokens,
      },
      debug: opts.debug ? debug : undefined,
    };

    this._lastDebug = opts.debug ? debug : null;
    return res;
  }
}
