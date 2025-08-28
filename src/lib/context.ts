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
  maxCharsBudget?: number; // NEW (optional)
}

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
      if (!last || r.startOffset > last.endOffset) {
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

      // CHANGED: include the current top-level node too
      const blocks: Array<{ startOffset: number; endOffset: number }> = [];
      blocks.push(this.expandNodeToFullLinesWithLeadingComments(topLevel)); // 👈
      if (prev)
        blocks.push(this.expandNodeToFullLinesWithLeadingComments(prev)); // 👈
      if (next)
        blocks.push(this.expandNodeToFullLinesWithLeadingComments(next)); // 👈

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
}
