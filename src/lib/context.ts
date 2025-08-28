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

    return instance;
  }

  /**
   * Call this from Monaco's onDidChangeModelContent handler.
   * It records incremental edits; we only re-parse on demand.
   */
  onModelContentChanged(e: monaco.editor.IModelContentChangedEvent) {
    for (const change of e.changes) {
      const start: Position = {
        lineNumber: change.range.startLineNumber,
        column: change.range.startColumn,
      };
      const end: Position = {
        lineNumber: change.range.endLineNumber,
        column: change.range.endColumn,
      };

      // CHANGED: Use Monaco offsets directly (code units). No *2.
      const startOffset = this.model.getOffsetAt(start);
      const oldEndOffset = this.model.getOffsetAt(end);

      // CHANGED: new end offset = start + inserted text length (code units)
      const newEndOffset = startOffset + change.text.length;

      const startPosition: Point = {
        row: start.lineNumber - 1,
        column: start.column - 1,
      };
      const oldEndPosition: Point = {
        row: end.lineNumber - 1,
        column: end.column - 1,
      };
      const newEndPos = this.model.getPositionAt(newEndOffset);
      const newEndPosition: Point = {
        row: newEndPos.lineNumber - 1,
        column: newEndPos.column - 1,
      };

      this.pendingEdits.push({
        // CHANGED: Pass offsets as-is (no bytes conversion)
        startIndex: startOffset,
        oldEndIndex: oldEndOffset,
        newEndIndex: newEndOffset,
        startPosition,
        oldEndPosition,
        newEndPosition,
      });
    }

    this.dirty = true;
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
    const funcNode = this.findEnclosingFunctionLike(nodeAtCursor);
    if (funcNode) {
      // CHANGED: If function is used as an argument, include its wrapping call.
      const container = this.wrapFunctionIfArgument(funcNode);
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

      // If either sibling exists, collect them (excluding the current node itself).
      const blocks: Array<{ startOffset: number; endOffset: number }> = [];
      if (prev) blocks.push(this.expandNodeToFullLines(prev));
      if (next) blocks.push(this.expandNodeToFullLines(next));

      if (blocks.length > 0) {
        const startOffset = Math.min(...blocks.map((b) => b.startOffset));
        const endOffset = Math.max(...blocks.map((b) => b.endOffset));
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
    return this.linesAround(cursor, opts.fallbackLineWindow ?? 5);
  }

  /** Apply pending edits and reparse incrementally if needed */
  private ensureIncrementalParseUpToDate() {
    if (!this.dirty) return;

    if (!this.tree) {
      this.tree = this.parser.parse(this.model.getValue());
      this.pendingEdits = [];
      this.dirty = false;
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
  }

  //   /** Find the nearest enclosing function-like node */
  //   private findEnclosingFunctionLike(node: Node): Node | null {
  //     // TODO: Check if this supports capturing pm.* style syntax like pm.test, pm.sendRequest etc...
  //     const functionTypes = new Set<string>([
  //       "function_declaration",
  //       "function",
  //       "function_expression",
  //       "arrow_function",
  //       "method_definition",
  //       "generator_function",
  //       "class_method",
  //       // Helpful for JS: functions passed to calls like pm.test(..., function() { ... })
  //       // We treat the containing function body as function-like if we are inside.
  //     ]);

  //     let cur: Node | null = node;
  //     while (cur) {
  //       if (functionTypes.has(cur.type)) return cur;

  //       // Heuristic: if we're inside an argument list and one of the arguments is a function,
  //       // jump up to that function node.
  //       if (cur.type === "arguments") {
  //         const fnArg = cur.namedChildren.find(
  //           (c) => c && functionTypes.has(c.type)
  //         );
  //         if (fnArg) return fnArg;
  //       }
  //       cur = cur.parent;
  //     }
  //     return null;
  //   }

  /** Find the nearest enclosing function-like node */
  private findEnclosingFunctionLike(node: Node): Node | null {
    // CHANGED: centralized helpers for robust detection
    const isFunctionLike = (n: Node | null) =>
      !!n &&
      (n.type === "function_declaration" ||
        n.type === "function_expression" ||
        n.type === "arrow_function" ||
        n.type === "method_definition" ||
        n.type === "generator_function" ||
        n.type === "class_method" ||
        n.type === "function");

    const isFunctionBody = (n: Node | null) =>
      !!n && (n.type === "statement_block" || n.type === "function_body");

    let cur: Node | null = node;
    while (cur) {
      if (isFunctionLike(cur)) return cur;

      // CHANGED: hop from body -> its function
      if (isFunctionBody(cur) && cur.parent && isFunctionLike(cur.parent)) {
        return cur.parent;
      }

      // If inside a call's arguments, prefer a function argument
      if (cur.type === "arguments") {
        const fnArg = cur.namedChildren.find(isFunctionLike);
        if (fnArg) return fnArg;
      }

      cur = cur.parent;
    }
    return null;
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
  private linesAround(cursor: Position, window: number): ExtractContextResult {
    const totalLines = this.model.getLineCount();
    const startLine = Math.max(1, cursor.lineNumber - window);
    const endLine = Math.min(totalLines, cursor.lineNumber + window);

    const startOffset = this.model.getOffsetAt({
      lineNumber: startLine,
      column: 1,
    });
    const endOffset = this.model.getOffsetAt({
      lineNumber: endLine,
      column: this.lineEndColumn(endLine),
    });

    const text = this.model.getValueInRange({
      startLineNumber: startLine,
      startColumn: 1,
      endLineNumber: endLine,
      endColumn: this.lineEndColumn(endLine),
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
