import type { Parser, Point, Tree, Node } from "web-tree-sitter";
import type { monaco } from "./monacoSetup";
import { ensureParser } from "./treeSitterInit";

type Position = { lineNumber: number; column: number };

interface TokenBudgets {
  total: number;
  sections: {
    linesAroundCursor: number;
  };
}

const ContextExtractorDefaultConfig: ContextExtractorOptions = {
  cursorPosition: { lineNumber: 1, column: 1 },
  prefixLines: 3,
  suffixLines: 3,
  nestingLevel: 10,
  tokenBudgets: {
    total: 1000,
    sections: {
      linesAroundCursor: 0.5,
    },
  },
};

interface DebugConfig {
  tokensPicked: TokenBudgets;
}

interface ContextExtractorOptions {
  cursorPosition: Position;
  prefixLines: number;
  suffixLines: number;
  nestingLevel: number;
  tokenBudgets: TokenBudgets;
}

interface TreeEdit {
  /**
   * The starting index of the edit
   */
  startIndex: number;
  oldEndIndex: number;
  newEndIndex: number;

  /**
   * Start position of the edit
   */
  startPosition: Point;
  oldEndPosition: Point;
  newEndPosition: Point;
}

export interface ExtractedContext {
  debug?: DebugConfig;
  linesAroundCursor: string;
}

class ContextExtractorModule {
  /**
   * Tree-sitter parser instance
   */
  private parser!: Parser;
  /**
   * Current AST Tree
   */
  private tree: Tree | null = null;
  /**
   * Indicates whether the context extractor is dirty (i.e., has unsaved changes)
   */
  private dirty: boolean = false;
  private lastParseTime: number = Date.now();
  private pendingEdits: Array<TreeEdit> = [];

  private lastDebugMetrics: DebugConfig = {
    tokensPicked: {
      total: 0,
      sections: {
        linesAroundCursor: 0,
      },
    },
  };

  /**
   * Monaco editor text model
   */
  private model: monaco.editor.ITextModel;

  constructor(model: monaco.editor.ITextModel) {
    this.model = model;
  }

  static async createTree(
    model: monaco.editor.ITextModel
  ): Promise<ContextExtractorModule> {
    const parser = await ensureParser();

    const instance = new ContextExtractorModule(model);
    instance.parser = parser;

    // Initial tree parsing
    instance.tree = instance.parser.parse(model.getValue());
    instance.dirty = false;
    instance.lastParseTime = Date.now();

    return instance;
  }

  get treeStatus() {
    return {
      hasTree: !!this.tree,
      isDirty: this.dirty,
      lastParseTime: this.lastParseTime,
      pendingEditsCount: this.pendingEdits.length,
    };
  }

  /**
   * Calculates new position after inserting text, handling multi-line insertions.
   * Used for incremental parsing to track position changes.
   *
   * @param start Starting position before text insertion
   * @param text Text that was inserted
   * @returns New position after insertion
   */
  private advancePointByText(start: Point, text: string): Point {
    // Normalize line endings
    const norm = text.replace(/\r\n?/g, "\n");
    const lines = norm.split("\n");

    if (lines.length === 1) {
      // Single-line insertion
      return { row: start.row, column: start.column + lines[0].length };
    }

    // Multi-line insertion
    const lastLine = lines[lines.length - 1];
    return {
      row: start.row + (lines.length - 1),
      column: lastLine.length,
    };
  }

  onModelContentChanged(e: monaco.editor.IModelContentChangedEvent) {
    const changes = [...e.changes].sort(
      (a, b) => a.rangeOffset - b.rangeOffset
    );

    for (const change of changes) {
      // PRE-CHANGE Positions
      const startPosition: Point = {
        row: change.range.startLineNumber - 1,
        column: change.range.startColumn - 1,
      };

      const oldEndPosition: Point = {
        row: change.range.endLineNumber - 1,
        column: change.range.endColumn - 1,
      };

      // PRE-CHANGE Indices (use the event's offsets)
      const startIndex = change.rangeOffset;
      const oldEndIndex = change.rangeOffset + change.rangeLength;

      // POST-CHANGE indices and positions
      const newEndIndex = startIndex;
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

  public buildTree() {
    this.ensureIncrementalParseUpToDate();
  }

  /**
   * Ensures the AST tree is up-to-date by applying pending incremental edits
   * and re-parsing if necessary. This method is called automatically before
   * any context extraction to ensure we're working with current syntax tree.
   */
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

  /**
   * Get an approximate token count based on how LLMs like Chat GPT or Qwen Coder count it
   * @param text Text to count tokens for
   */
  private approximateTokenCount(text: string): number {
    const tokens = text.split(/\s+/);
    return tokens.length;
  }

  /**
   * Wraps a function node with its containing call expression if it's used as an argument.
   * This ensures we capture complete constructs like `pm.test("name", function() { ... })`
   * instead of just the inner function.
   *
   * @param funcNode Function node to potentially wrap
   * @returns Original node or wrapping call/new expression
   */
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
   * Get the prefix lines based on the current cursor position.
   * Rules:
   * - Take the `prefixLines` number of lines before the current cursorPosition.lineNumber
   * - Make sure to never cut a block in between, if the cursor lands in the middle of a code block
   * then the entire block till the top nesting level should be included.
   * - Check the token budget and add it to the debug logs
   * @param cursorPosition Current Cursor Position
   * @param options Context Extractor Options to get relevant values
   */
  getLinesAroundCursor({
    cursorPosition,
    nestingLevel,
  }: ContextExtractorOptions = ContextExtractorDefaultConfig) {
    // Ensure AST is up to date
    this.ensureIncrementalParseUpToDate();

    if (!this.tree) {
      console.error(
        "🚀 ~ ContextExtractorModule ~ getPrefixLines ~ No AST available"
      );
      return "";
    }

    // Use AST-aware extraction
    const tsPos: Point = {
      row: cursorPosition.lineNumber - 1,
      column: cursorPosition.column - 1,
    };

    const nodeAtCursor = this.tree.rootNode.descendantForPosition(tsPos);
    if (!nodeAtCursor) {
      // Fallback if cursor position is invalid
      return "";
    }

    const innerFunction = this.nearestFunctionFrom(nodeAtCursor);

    const blocks: string[] = [];

    // Case 1: We're inside a function
    if (innerFunction) {
      const targetFunction = this.elevateFunctionByLevels(
        innerFunction,
        nestingLevel
      );

      // Special case: If function is an argument, take the entire construct
      const container = this.wrapFunctionIfArgument(targetFunction);

      const { startOffset, endOffset } =
        this.expandNodeToFullLinesWithLeadingComments(container);

      blocks.push(
        this.model.getValueInRange({
          startLineNumber: this.model.getPositionAt(startOffset).lineNumber,
          startColumn: 1,
          endLineNumber: this.model.getPositionAt(endOffset).lineNumber,
          endColumn: this.model.getLineMaxColumn(
            this.model.getPositionAt(endOffset).lineNumber
          ),
        })
      );
    }

    // Scan for `prefixLines` above the current function
    // If the currentLine - prefixLines lands inside a block, take that block

    // Scan for `suffixLines` below the current function
    // If the currentLine + suffixLines lands inside a block, take that block

    // Check for token budget of linesAroundCursor
    // Remove the blocks which go over budget, divide the prefix and suffix budget in half
    return blocks.length > 0 ? blocks.join("\n") : "// No blocks detected";
  }

  /** MONACO HELPERS */

  /**
   * Gets the maximum column number for a given line
   */
  private lineEndColumn(lineNumber: number): number {
    return this.model.getLineMaxColumn(lineNumber);
  }

  /** AST HELPERS */

  /**
   * Finds the nearest enclosing function from a given node.
   * Traverses up the AST tree looking for function-like constructs or function bodies.
   * Also searches within argument lists for function expressions.
   *
   * @param node Starting node to search from
   * @returns Nearest function node or null if none found
   */
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

  /**
   * Determines if a node represents a function body.
   * Function bodies are the block containers for function code.
   *
   * @param n Node to check
   * @returns True if node is a function body block
   */
  private isFunctionBody(n: Node | null): boolean {
    return !!n && (n.type === "statement_block" || n.type === "function_body");
  }

  /**
   * Checks if a node represents a function-like construct
   * @param n Node to check
   * @returns True if node is function-like
   */
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

  /**
   * Gets the previous named sibling node, skipping any missing/error nodes.
   * Missing nodes are placeholder nodes created by the parser for incomplete syntax.
   *
   * @param node Node to find the previous sibling for
   * @returns Previous named sibling or null if none exists
   */
  private previousNamedSibling(node: Node): Node | null {
    let prev = node.previousNamedSibling;
    while (prev && prev.isMissing) prev = prev.previousNamedSibling;
    return prev ?? null;
  }

  /**
   * Gets the next named sibling node, skipping any missing/error nodes.
   * Missing nodes are placeholder nodes created by the parser for incomplete syntax.
   *
   * @param node Node to find the next sibling for
   * @returns Next named sibling or null if none exists
   */
  private nextNamedSibling(node: Node): Node | null {
    let next = node.nextNamedSibling;
    while (next && next.isMissing) next = next.nextNamedSibling;
    return next ?? null;
  }

  /**
   * Expands a node to include leading comments and full line boundaries.
   * Searches backwards for contiguous comment lines and includes them in the range.
   * This preserves important context like JSDoc comments and inline explanations.
   *
   * @param node Node to expand
   * @returns Range with start/end offsets including comments and full lines
   */
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

  /**
   * Elevates a function node to a higher nesting level by traversing up the AST.
   * Used for context expansion when we want broader scope than the immediate function.
   * Safely limits elevation to prevent infinite traversal.
   *
   * @param funcNode Starting function node
   * @param levels Number of function nesting levels to traverse upward
   * @returns Elevated function node (or original if elevation not possible)
   */
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

  /** PUBLIC FUNCTIONS */
  public getDebugMetrics(): DebugConfig {
    return this.lastDebugMetrics;
  }

  public getExtractedContext(
    config: ContextExtractorOptions
  ): ExtractedContext {
    const linesAroundCursor = this.getLinesAroundCursor(config);

    const debug = this.getDebugMetrics();

    return {
      linesAroundCursor,
      debug,
    };
  }
}

export default ContextExtractorModule;
