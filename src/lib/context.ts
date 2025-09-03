/**
 * @fileoverview Context Extractor for JavaScript/TypeScript Code
 *
 * This module provides intelligent context extraction from code using Tree-sitter AST parsing.
 * It extracts relevant code context around a cursor position for use with Large Language Models (LLMs).
 *
 * Key Features:
 * - AST-aware context extraction
 * - Incremental parsing for performance
 * - Multiple extraction strategies (function-based, block-based, line-based)
 * - Ranked context sections with dependency analysis
 * - Support for Postman test scripts
 *
 * @author Vivek Nigam
 * @version 1.0.0
 */

import type * as monaco from "monaco-editor";
import { Parser, type Point, Tree, Node } from "web-tree-sitter";
import { ensureParser } from "./treeSitterInit";
import CODE_STOPWORDS from "./stopwords";

// ===== TYPE DEFINITIONS =====

/**
 * Represents a position in the code editor
 */
type Position = { lineNumber: number; column: number };

/**
 * Options for global declarations extraction
 */
export interface GlobalDeclarationsOptions {
  /**
   * Maximum number of characters to include for global declarations
   * @default 2000
   */
  maxCharsBudget?: number;

  /**
   * Whether to include leading comments with declarations
   * @default true
   */
  includeLeadingComments?: boolean;
}

/**
 * Result of global declarations extraction
 */
export interface GlobalDeclarationsResult {
  /**
   * The extracted global declarations text
   */
  text: string;

  /**
   * Array of declaration ranges included in the result
   */
  declarations: Array<{
    startOffset: number;
    endOffset: number;
    name: string;
    priority: "current-scope" | "high-usage" | "other";
    usageCount: number;
  }>;

  /**
   * Metadata about the extraction
   */
  meta: {
    totalDeclarations: number;
    currentScopeCount: number;
    highUsageCount: number;
    otherCount: number;
    budgetUsed: number;
    budgetLimit: number;
  };
}

/**
 * Configuration options for context extraction
 */
export interface ContextOptions {
  /**
   * If no function/blocks are found, number of lines above and below to include.
   * @default 5
   */
  fallbackLineWindow?: number;

  /**
   * Level of context extraction for a given code block.
   * 0 => innermost function only (current behavior),
   * 1 => parent function, 2 => grandparent, etc.
   * @default 0
   * @max 50
   */
  nestingLevel?: number;

  /**
   * Hard budget for fallback & sibling strategies (approx chars).
   * @default 4000 (~1k tokens)
   */
  maxCharsBudget?: number;

  /**
   * Percentage allocation for different tiers
   * @default { A: 0.4, B: 0.3, C: 0.2, D: 0.1 }
   */
  tierPercents?: { A: number; B: number; C: number; D: number };

  /**
   * Whether to include leading comments with code blocks
   * @default true
   */
  includeLeadingComments?: boolean;

  /**
   * If true, Tier A is always raw lines around the cursor (ignores AST)
   * @default false
   */
  forceRawLinesAroundCursor?: boolean;

  /**
   * Lines before cursor when using raw lines
   * @default 5
   */
  rawPrefixLines?: number;

  /**
   * Lines after cursor when using raw lines
   * @default 5
   */
  rawSuffixLines?: number;

  /**
   * Number of lines to scan before cursor position for prefix context
   * @default 5
   */
  numberOfPrefixLines?: number;

  /**
   * Number of lines to scan after cursor position for suffix context
   * @default 5
   */
  numberOfSuffixLines?: number;
}

/**
 * Extended options for ranked context sections
 */
export interface RankedSectionsOptions extends ContextOptions {
  /**
   * Emit rich debug info about ranking/selection
   * @default false
   */
  debug?: boolean;
}

/**
 * Debug information for context extraction analysis
 */
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

/**
 * Ranked context sections result with different tiers of relevance
 */
export interface ExtractRankedContextSections {
  /** Tier A: The local/test block around cursor */
  linesAroundCursor: string;
  /** Tier B: Selected globals/const/let/var & pulled dependencies */
  declarations: string;
  /** Tier C: Small non-global helpers that made the cut */
  relevantLines: string;
  /** Tier D: Other existing tests chosen for context or compact skeletons */
  existingTests: string;
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
  /** Optional debug payload with rankings, signals, and reasons */
  debug?: DebugInfo;
}

/**
 * Result of basic context extraction
 */
export interface ExtractContextResult {
  /**
   * The full text slice to feed to the LLM
   */
  text: string;
  /**
   * The 0-based start and end offsets (UTF-16 code units) in the model
   * (Useful if you want to highlight the region in the editor)
   */
  startOffset: number;
  endOffset: number;
  /**
   * What strategy was used to obtain this context
   */
  strategy:
    | "enclosing-function"
    | "adjacent-top-level-blocks"
    | "fallback-lines"
    | "top-level-with-syntax-sanity"
    | "enclosing-block-with-context";
}

// ===== RANKING MODEL TYPES =====

/**
 * Represents a code block range with AST node information
 */
type BlockRange = {
  startOffset: number;
  endOffset: number;
  node: Node;
  kind?: string;
};

/**
 * A ranked code block with scoring signals
 */
type RankedBlock = BlockRange & {
  sizeChars: number;
  signals: {
    lexical: number; // Distance-based relevance
    reference: number; // Dependency-based relevance
    kind: number; // Type-based relevance
    complexity: number; // Size-based penalty
  };
  score: number;
};

/**
 * Types of top-level blocks for similarity and display
 */
type TopBlockKind =
  | "pm_test"
  | "function_declaration"
  | "arrow_function_decl" // const x = () => {}
  | "function_expression_decl" // const x = function () {}
  | "lexical_declaration" // const/let (non-fn)
  | "variable_declaration"; // var (non-fn)

/**
 * Top-level code block with categorization
 */
type TopBlock = {
  kind: TopBlockKind;
  node: Node;
  startOffset: number;
  endOffset: number;
};

// ===== CONSTANTS =====

/** Default percentage allocation for different context tiers */
const DEFAULT_TIER_PERCENTS = { A: 0.4, B: 0.3, C: 0.2, D: 0.1 } as const;

// Scoring weights - tunable via telemetry
const W_LEX = 0.3; // Lexical proximity weight
const W_REF = 0.35; // Reference/dependency weight (higher - dependencies matter)
const W_KIND = 0.2; // Block type preference weight
const W_COMP = -0.05; // Complexity penalty (negative for size penalty)
const W_TITLE = 0.2; // Title/name overlap boost

// ===== UTILITY FUNCTIONS =====

/**
 * Clamps a value between 0 and 1
 */
function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Splits camelCase and snake_case strings into individual words
 */
function splitCamelSnake(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\W]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Tokenizes text, filters stopwords, and removes duplicates
 */
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
  // Deduplicate while preserving order
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

/**
 * Calculates Jaccard similarity between two sets
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  // Iterate smaller set for performance
  const small = a.size <= b.size ? a : b;
  const big = a.size <= b.size ? b : a;
  small.forEach((t) => big.has(t) && inter++);
  return inter / (a.size + b.size - inter);
}

// ===== MAIN CLASS =====

/**
 * ContextExtractor provides intelligent code context extraction using Tree-sitter AST parsing.
 *
 * Features:
 * - Incremental parsing for performance
 * - Multiple extraction strategies
 * - AST-aware context boundaries
 * - Dependency analysis and ranking
 * - Support for JavaScript/TypeScript and Postman test scripts
 *
 * @example
 * ```typescript
 * const extractor = await ContextExtractor.create(model);
 * const context = extractor.getContextAroundCursor({ lineNumber: 10, column: 5 });
 * console.log(context.text);
 * ```
 */
export class ContextExtractor {
  // ===== PRIVATE PROPERTIES =====

  /** Tree-sitter parser instance for JavaScript/TypeScript */
  private parser!: Parser;

  /** Current AST tree, null if not yet parsed */
  private tree: Tree | null = null;

  /** Whether the tree needs to be re-parsed due to changes */
  private dirty = true;

  /** Timestamp of the last successful parse operation */
  private lastParseTime: number = 0;

  /**
   * Pending incremental edits between parses.
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

  /** Monaco editor text model that this extractor is bound to */
  private model: monaco.editor.ITextModel;

  /** Debug information from the last context extraction operation */
  private _lastDebug: DebugInfo | null = null;

  /** Reserved ranges to prevent overlap during ranked extraction */
  private classRangeTaken: Array<{ startOffset: number; endOffset: number }> =
    [];

  // ===== CONSTRUCTOR AND FACTORY =====

  /**
   * Private constructor - use ContextExtractor.create() instead
   * @param model Monaco text model to bind to
   */
  private constructor(model: monaco.editor.ITextModel) {
    this.model = model;
  }

  /**
   * Factory method to create and initialize a ContextExtractor instance.
   * Initializes Tree-sitter parser and performs initial AST parsing.
   *
   * @param model Monaco text model to extract context from
   * @returns Promise resolving to initialized ContextExtractor instance
   *
   * @example
   * ```typescript
   * const model = monaco.editor.createModel(code, 'javascript');
   * const extractor = await ContextExtractor.create(model);
   * ```
   */
  static async create(
    model: monaco.editor.ITextModel
  ): Promise<ContextExtractor> {
    // Initialize Tree-sitter parser
    const parser = await ensureParser();

    const instance = new ContextExtractor(model);
    instance.parser = parser;

    // Perform initial parse
    instance.tree = instance.parser.parse(model.getValue());
    instance.dirty = false;
    instance.lastParseTime = Date.now();

    return instance;
  }

  // ===== PUBLIC API METHODS =====

  /**
   * Gets the current status of the AST tree
   * @returns Object containing tree status information
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
   * Forces immediate rebuild of the AST tree
   * Useful when you need the tree to be up-to-date immediately
   */
  forceBuildTree() {
    this.ensureIncrementalParseUpToDate();
  }

  /**
   * Gets debug information from the last context extraction operation
   * @returns Debug information or null if no extraction has been performed
   */
  public getLastDebug(): DebugInfo | null {
    return this._lastDebug;
  }

  /**
   * Handles content changes from Monaco editor.
   * Call this from Monaco's onDidChangeModelContent handler.
   * Records incremental edits for efficient re-parsing.
   *
   * @param e Monaco content change event
   *
   * @example
   * ```typescript
   * model.onDidChangeModelContent((e) => {
   *   extractor.onModelContentChanged(e);
   * });
   * ```
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

  // ===== CORE PARSING AND AST MANAGEMENT =====

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

  // ===== NODE TYPE CHECKING AND CLASSIFICATION =====

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
   * Merges overlapping and adjacent ranges into a sorted, non-overlapping list.
   * This is essential for creating contiguous text blocks from multiple AST nodes.
   *
   * @param ranges Array of ranges with start and end offsets
   * @returns Merged and sorted array of non-overlapping ranges
   */
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
   * Checks if a node or any of its ancestors have parse errors or missing nodes.
   * This helps detect unfinished or syntactically incorrect code that needs special handling.
   *
   * @param n Node to check (will traverse up the parent chain)
   * @returns True if any node in the ancestor chain has errors
   */
  private nodeOrAncestorsHaveError(n: Node | null): boolean {
    let p: Node | null = n;
    // web-tree-sitter nodes support hasError() and isMissing
    while (p) {
      if (p.hasError || p.isMissing) return true;
      p = p.parent;
    }
    return this.tree?.rootNode?.hasError ?? false;
  }

  /**
   * Uses lightweight text heuristics to detect likely unfinished code near the cursor.
   * Checks for unbalanced parentheses/braces and common unfinished patterns.
   * This is much faster than deep AST analysis and catches most common cases.
   *
   * @param cursor Current cursor position
   * @returns True if code appears unfinished or incomplete
   */
  private isLikelyUnfinishedNearCursor(cursor: Position): boolean {
    const total = this.model.getLineCount();
    const from = Math.max(1, cursor.lineNumber - 2);
    const to = Math.min(total, cursor.lineNumber + 30); // small forward lookahead

    const text = this.model.getValueInRange({
      startLineNumber: from,
      startColumn: 1,
      endLineNumber: to,
      endColumn: this.lineEndColumn(to),
    });

    // Count braces/parens (very lightweight; good enough for “unfinished”)
    let paren = 0,
      brace = 0;
    for (const ch of text) {
      if (ch === "(") paren++;
      else if (ch === ")") paren = Math.max(0, paren - 1);
      else if (ch === "{") brace++;
      else if (ch === "}") brace = Math.max(0, brace - 1);
    }

    // Extra hint: line looks like a starting construct w/o closure nearby
    const near = this.model.getLineContent(cursor.lineNumber);
    const startsCallOrFn = /\b(pm\.test\s*\(|function\b|=>\s*\{?$)/.test(near);

    return paren > 0 || brace > 0 || startsCallOrFn;
  }

  /**
   * Extracts raw, contiguous full lines around the cursor without AST analysis.
   * This is the ultimate fallback when AST parsing fails or produces unreliable results.
   * Always returns complete lines (never cuts mid-line) to maintain syntax validity.
   *
   * @param cursor Current cursor position
   * @param beforeLines Number of lines to include before cursor
   * @param afterLines Number of lines to include after cursor
   * @returns Context result with raw text lines
   */
  private rawLinesAround(
    cursor: Position,
    beforeLines: number,
    afterLines: number
  ): ExtractContextResult {
    const total = this.model.getLineCount();
    const startLine = Math.max(1, cursor.lineNumber - beforeLines);
    const endLine = Math.min(total, cursor.lineNumber + afterLines);

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

  /**
   * Hybrid extraction strategy for unfinished/incomplete code.
   * Combines AST-based block detection with raw line extraction for current function.
   *
   * Strategy:
   * 1. Find the current incomplete function/block using AST
   * 2. Include the complete current block up to cursor (raw to preserve unfinished syntax)
   * 3. Add complete neighboring blocks as context
   * 4. Merge all ranges and return contiguous text
   *
   * This ensures we get meaningful context even for broken/incomplete code.
   *
   * @param cursor Current cursor position
   * @param beforeLines Fallback lines before cursor if no AST context
   * @param afterLines Fallback lines after cursor if no AST context
   * @returns Context result with hybrid extraction
   */
  private hybridUnfinishedAround(
    cursor: Position,
    beforeLines: number,
    afterLines: number
  ): ExtractContextResult {
    const total = this.model.getLineCount();
    const startLine = Math.max(1, cursor.lineNumber - beforeLines);
    const endLine = Math.min(total, cursor.lineNumber + afterLines);

    const tsPos: Point = {
      row: cursor.lineNumber - 1,
      column: cursor.column - 1,
    };
    const nodeAt = this.tree?.rootNode.descendantForPosition(tsPos) ?? null;

    // Find the unfinished container (prefer function-like wrapped in call_expression)
    let container: Node | null = null;
    if (nodeAt) {
      let cur: Node | null = nodeAt;
      while (cur) {
        if (this.isFunctionLike(cur)) {
          container = this.wrapFunctionIfArgument(cur);
          break;
        }
        if (this.isWholeBlockCandidate(cur)) {
          container = this.wholeBlockContainer(cur);
          break;
        }
        cur = cur.parent;
      }
    }
    if (!container) {
      // Fallback: raw window
      return this.rawLinesAround(cursor, beforeLines, afterLines);
    }

    // Raw range for the unfinished container: from its real start (with leading comments) to cursor line end
    const unfinishedStart =
      this.expandNodeToFullLinesWithLeadingComments(container).startOffset;
    const unfinishedEnd = this.model.getOffsetAt({
      lineNumber: cursor.lineNumber,
      column: this.lineEndColumn(cursor.lineNumber),
    });
    const unfinishedRange = {
      startOffset: unfinishedStart,
      endOffset: unfinishedEnd,
    };

    // Top-level neighbors: always include prev/next whole blocks (no line-window restriction)
    const top = this.topLevelAncestor(container) ?? container;
    const prevTop = this.previousNamedSibling(top);
    const nextTop = this.nextNamedSibling(top);

    const neighborRanges: Array<{ startOffset: number; endOffset: number }> =
      [];
    const pushWhole = (n: Node | null) => {
      if (!n) return;
      const r = this.expandNodeToFullLinesWithLeadingComments(n);
      neighborRanges.push(r);
    };
    pushWhole(prevTop);
    pushWhole(nextTop);

    // Also include any full blocks that intersect the raw window (optional, won’t slice)
    const windowBlocks = this.collectWholeBlocksIntersectingWindow(
      startLine,
      endLine
    ).map((b) => ({ startOffset: b.startOffset, endOffset: b.endOffset }));

    // Build final ranges: unfinished current block + neighbors + window blocks
    const ranges = [unfinishedRange, ...neighborRanges, ...windowBlocks];

    // Merge adjacent/overlapping and produce final text
    const merged = this.mergeRanges(ranges);
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

  /**
   * Extracts context around a cursor position using intelligent AST-based strategies.
   *
   * This method implements a two-case strategy based on cursor position:
   * Case (a): Cursor at top level - Use prefix/suffix lines with syntax sanity
   * Case (b): Cursor inside block - Take entire block + prefix/suffix from block boundaries
   *
   * Special handling for unfinished/broken code:
   * - Detects parse errors and syntax issues
   * - Uses hybrid approach for incomplete functions
   * - Always preserves complete blocks (never cuts mid-line)
   *
   * @param cursor Position in the code to extract context around
   * @param opts Configuration options for extraction
   * @returns Context result with text, offsets, and strategy used
   *
   * @example
   * ```typescript
   * const context = extractor.getContextAroundCursor(
   *   { lineNumber: 42, column: 10 },
   *   { numberOfPrefixLines: 10, numberOfSuffixLines: 10 }
   * );
   * console.log(`Strategy: ${context.strategy}`);
   * console.log(`Context: ${context.text}`);
   * ```
   */
  getContextAroundCursor(
    cursor: Position,
    opts: ContextOptions = {}
  ): ExtractContextResult {
    this.ensureIncrementalParseUpToDate();

    // Get configuration values with fallbacks
    const prefixLines =
      opts.numberOfPrefixLines ??
      opts.rawPrefixLines ??
      opts.fallbackLineWindow ??
      5;
    const suffixLines =
      opts.numberOfSuffixLines ??
      opts.rawSuffixLines ??
      opts.fallbackLineWindow ??
      5;

    if (!this.tree) {
      // No tree — just give raw lines with syntax sanity
      const { startLine, endLine } = this.expandWithSyntaxSanity(
        cursor.lineNumber - prefixLines,
        cursor.lineNumber + suffixLines
      );
      return this.extractLinesRange(startLine, endLine, "fallback-lines");
    }

    const nodeAtCursor = this.tree.rootNode.descendantForPosition({
      row: cursor.lineNumber - 1,
      column: cursor.column - 1,
    });

    const shouldUseRaw =
      !nodeAtCursor ||
      this.nodeOrAncestorsHaveError(nodeAtCursor) ||
      this.isLikelyUnfinishedNearCursor(cursor);

    if (shouldUseRaw) {
      // Fallback to hybrid behavior for broken/unfinished code
      return this.hybridUnfinishedAround(cursor, prefixLines, suffixLines);
    }

    // Determine if cursor is at top level or inside a block
    const isAtTopLevel = this.isCursorAtTopLevel(cursor);

    if (isAtTopLevel) {
      // Case (a): Cursor at top level - use prefix/suffix with syntax sanity
      const { startLine, endLine } = this.expandWithSyntaxSanity(
        cursor.lineNumber - prefixLines,
        cursor.lineNumber + suffixLines
      );
      return this.extractLinesRange(
        startLine,
        endLine,
        "top-level-with-syntax-sanity"
      );
    } else {
      // Case (b): Cursor inside block - take entire block + prefix/suffix from boundaries
      const enclosingBlock = this.getCurrentEnclosingBlock(cursor);

      if (enclosingBlock) {
        // Get the topmost parent of the current block (top-level ancestor)
        const topmostParent =
          this.topLevelAncestor(enclosingBlock) ?? enclosingBlock;

        // Expand the current block to full lines with comments
        const blockRange =
          opts.includeLeadingComments ?? true
            ? this.expandNodeToFullLinesWithLeadingComments(enclosingBlock)
            : this.expandNodeToFullLines(enclosingBlock);

        // Get the topmost parent's boundaries
        const parentRange = this.expandNodeToFullLines(topmostParent);
        const parentStartLine = this.model.getPositionAt(
          parentRange.startOffset
        ).lineNumber;
        const parentEndLine = this.model.getPositionAt(
          parentRange.endOffset
        ).lineNumber;

        // Calculate prefix/suffix from the topmost parent boundaries
        const { startLine: prefixStart } = this.expandWithSyntaxSanity(
          parentStartLine - prefixLines,
          parentStartLine - 1
        );

        const { endLine: suffixEnd } = this.expandWithSyntaxSanity(
          parentEndLine + 1,
          parentEndLine + suffixLines
        );

        // Combine: prefix + current block + suffix
        const finalStartLine = Math.min(
          prefixStart,
          this.model.getPositionAt(blockRange.startOffset).lineNumber
        );
        const finalEndLine = Math.max(
          suffixEnd,
          this.model.getPositionAt(blockRange.endOffset).lineNumber
        );

        return this.extractLinesRange(
          finalStartLine,
          finalEndLine,
          "enclosing-block-with-context"
        );
      } else {
        // Fallback if we can't find an enclosing block
        const { startLine, endLine } = this.expandWithSyntaxSanity(
          cursor.lineNumber - prefixLines,
          cursor.lineNumber + suffixLines
        );
        return this.extractLinesRange(startLine, endLine, "fallback-lines");
      }
    }
  }

  /**
   * Helper method to extract text from a line range and return as ExtractContextResult
   * @param startLine Starting line (1-based)
   * @param endLine Ending line (1-based)
   * @param strategy Strategy name for the result
   * @returns Context result with extracted text
   */
  private extractLinesRange(
    startLine: number,
    endLine: number,
    strategy: ExtractContextResult["strategy"]
  ): ExtractContextResult {
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

    return { text, startOffset, endOffset, strategy };
  }

  /**
   * Extracts global declarations based on the currently editing block with intelligent prioritization.
   *
   * Priority logic:
   * 1. Declarations called/read in current block scope (up to topmost level)
   * 2. Most used declarations across the entire file
   * 3. Other available declarations if budget allows
   *
   * Always maintains proper order (as they appear in file) and never cuts lines.
   *
   * @param cursor Current cursor position to determine the editing context
   * @param opts Configuration options for extraction
   * @returns Global declarations result with prioritized text and metadata
   *
   * @example
   * ```typescript
   * const declarations = extractor.getGlobalDeclarations(
   *   { lineNumber: 42, column: 10 },
   *   { maxCharsBudget: 2000 }
   * );
   * console.log(declarations.text);
   * console.log(`Found ${declarations.meta.currentScopeCount} current scope declarations`);
   * ```
   */
  public getGlobalDeclarations(
    cursor: Position,
    opts: GlobalDeclarationsOptions = {}
  ): GlobalDeclarationsResult {
    this.ensureIncrementalParseUpToDate();

    const maxBudget = opts.maxCharsBudget ?? 2000;
    const includeComments = opts.includeLeadingComments ?? true;

    // Get all global declarations
    const allDeclarations = this.collectGlobalBlockCandidates();
    if (allDeclarations.length === 0) {
      return {
        text: "",
        declarations: [],
        meta: {
          totalDeclarations: 0,
          currentScopeCount: 0,
          highUsageCount: 0,
          otherCount: 0,
          budgetUsed: 0,
          budgetLimit: maxBudget,
        },
      };
    }

    // Analyze usage patterns
    const usageFrequency = this.analyzeGlobalUsageFrequency();
    const currentScopeIdentifiers =
      this.getIdentifiersUsedInCurrentScope(cursor);

    // Categorize declarations by priority
    type DeclarationWithPriority = {
      declaration: BlockRange;
      name: string;
      priority: "current-scope" | "high-usage" | "other";
      usageCount: number;
      size: number;
    };

    const categorized: DeclarationWithPriority[] = [];

    for (const decl of allDeclarations) {
      // Extract the primary name from this declaration
      const names = this.extractDeclarationNames(decl.node);
      const primaryName = names[0] || "unknown";
      const usageCount = usageFrequency.get(primaryName) || 0;

      // Determine priority
      let priority: DeclarationWithPriority["priority"] = "other";
      if (currentScopeIdentifiers.has(primaryName)) {
        priority = "current-scope";
      } else if (usageCount >= 2) {
        // Consider high-usage if used 2+ times across the file
        priority = "high-usage";
      }

      const size = decl.endOffset - decl.startOffset;

      categorized.push({
        declaration: decl,
        name: primaryName,
        priority,
        usageCount,
        size,
      });
    }

    // Sort within each priority group:
    // - Current scope: by usage count desc, then by file order
    // - High usage: by usage count desc, then by file order
    // - Other: by file order (startOffset)
    const sortedDeclarations = [
      ...categorized
        .filter((d) => d.priority === "current-scope")
        .sort((a, b) => {
          if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
          return a.declaration.startOffset - b.declaration.startOffset;
        }),
      ...categorized
        .filter((d) => d.priority === "high-usage")
        .sort((a, b) => {
          if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
          return a.declaration.startOffset - b.declaration.startOffset;
        }),
      ...categorized
        .filter((d) => d.priority === "other")
        .sort((a, b) => a.declaration.startOffset - b.declaration.startOffset),
    ];

    // Select declarations within budget, maintaining file order for final output
    const selected: DeclarationWithPriority[] = [];
    let budgetUsed = 0;

    for (const decl of sortedDeclarations) {
      if (budgetUsed + decl.size <= maxBudget) {
        selected.push(decl);
        budgetUsed += decl.size;
      }
    }

    // Sort selected declarations by file order for output
    selected.sort(
      (a, b) => a.declaration.startOffset - b.declaration.startOffset
    );

    // Extract text ranges
    const ranges = selected.map((decl) => {
      const range = includeComments
        ? this.expandNodeToFullLinesWithLeadingComments(decl.declaration.node)
        : this.expandNodeToFullLines(decl.declaration.node);

      return {
        startOffset: range.startOffset,
        endOffset: range.endOffset,
        name: decl.name,
        priority: decl.priority,
        usageCount: decl.usageCount,
      };
    });

    // Generate final text
    const text = this.textFromRanges(ranges);

    // Calculate metadata
    const currentScopeCount = selected.filter(
      (d) => d.priority === "current-scope"
    ).length;
    const highUsageCount = selected.filter(
      (d) => d.priority === "high-usage"
    ).length;
    const otherCount = selected.filter((d) => d.priority === "other").length;

    return {
      text,
      declarations: ranges,
      meta: {
        totalDeclarations: allDeclarations.length,
        currentScopeCount,
        highUsageCount,
        otherCount,
        budgetUsed,
        budgetLimit: maxBudget,
      },
    };
  }

  /**
   * Extracts the primary identifier names from a declaration node.
   * Handles function declarations, variable declarations, etc.
   *
   * @param node Declaration node to analyze
   * @returns Array of identifier names (primary name first)
   */
  private extractDeclarationNames(node: Node): string[] {
    const names: string[] = [];

    if (node.type === "function_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (name) names.push(name);
    } else if (
      node.type === "lexical_declaration" ||
      node.type === "variable_declaration"
    ) {
      // Walk through declarators to find identifier names
      const collectNames = (n: Node) => {
        if (n.type === "variable_declarator") {
          const id = n.childForFieldName("name");
          if (id?.type === "identifier" && id.text) {
            names.push(id.text);
          }
        }
        for (let i = 0; i < n.namedChildCount; i++) {
          collectNames(n.namedChild(i)!);
        }
      };
      collectNames(node);
    }

    return names;
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

  /**
   * Checks if a node is a candidate for whole block extraction
   * Includes functions, classes, variable declarations, control flow, etc.
   * @param n Node to check
   * @returns True if node should be treated as a complete block
   */
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

  /**
   * Collects complete block nodes that intersect with a given line window.
   * Only returns full nodes - never slices blocks at window boundaries.
   * This preserves syntactic integrity of code blocks.
   *
   * @param startLine Starting line number of the window (1-based)
   * @param endLine Ending line number of the window (1-based)
   * @returns Array of block ranges with their AST nodes
   */
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

  // ===== PRIVATE UTILITY METHODS =====

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
   * Determines if the cursor is at the top level (not inside any block/function).
   * A cursor is considered at top level if it's not inside any function, class, or block statement.
   *
   * @param cursor Current cursor position
   * @returns True if cursor is at top level, false if inside a block
   */
  private isCursorAtTopLevel(cursor: Position): boolean {
    if (!this.tree) return true; // If no AST, assume top level

    const tsPos: Point = {
      row: cursor.lineNumber - 1,
      column: cursor.column - 1,
    };
    const nodeAtCursor = this.tree.rootNode.descendantForPosition(tsPos);

    if (!nodeAtCursor) return true;

    // Walk up the AST to see if we're inside any block-like structure
    let current: Node | null = nodeAtCursor;
    while (current && current !== this.tree.rootNode) {
      // Check if we're inside a function, class, or block statement
      if (
        this.isFunctionLike(current) ||
        current.type === "class_declaration" ||
        current.type === "statement_block" ||
        current.type === "block_statement" ||
        current.type === "function_body" ||
        // Also check for control flow blocks
        current.type === "if_statement" ||
        current.type === "for_statement" ||
        current.type === "for_in_statement" ||
        current.type === "for_of_statement" ||
        current.type === "while_statement" ||
        current.type === "do_statement" ||
        current.type === "try_statement" ||
        current.type === "catch_clause" ||
        current.type === "finally_clause" ||
        current.type === "switch_statement"
      ) {
        return false; // We're inside a block
      }
      current = current.parent;
    }

    return true; // We're at top level
  }

  /**
   * Gets the current enclosing block node that contains the cursor.
   * Returns the nearest block-like ancestor (function, class, control flow, etc.)
   *
   * @param cursor Current cursor position
   * @returns The enclosing block node or null if at top level
   */
  private getCurrentEnclosingBlock(cursor: Position): Node | null {
    if (!this.tree) return null;

    const tsPos: Point = {
      row: cursor.lineNumber - 1,
      column: cursor.column - 1,
    };
    const nodeAtCursor = this.tree.rootNode.descendantForPosition(tsPos);

    if (!nodeAtCursor) return null;

    // Walk up to find the nearest enclosing block
    let current: Node | null = nodeAtCursor;
    while (current && current !== this.tree.rootNode) {
      if (
        this.isFunctionLike(current) ||
        current.type === "class_declaration" ||
        current.type === "statement_block" ||
        current.type === "block_statement" ||
        current.type === "function_body" ||
        current.type === "if_statement" ||
        current.type === "for_statement" ||
        current.type === "for_in_statement" ||
        current.type === "for_of_statement" ||
        current.type === "while_statement" ||
        current.type === "do_statement" ||
        current.type === "try_statement" ||
        current.type === "catch_clause" ||
        current.type === "finally_clause" ||
        current.type === "switch_statement"
      ) {
        return current;
      }
      current = current.parent;
    }

    return null; // No enclosing block found
  }

  /**
   * Expands prefix/suffix lines while maintaining syntax sanity.
   * If the expansion would cut into the middle of a block, includes the entire block.
   *
   * @param startLine Starting line for expansion (1-based)
   * @param endLine Ending line for expansion (1-based)
   * @returns Adjusted range that doesn't cut blocks in the middle
   */
  private expandWithSyntaxSanity(
    startLine: number,
    endLine: number
  ): { startLine: number; endLine: number } {
    if (!this.tree) {
      return { startLine, endLine };
    }

    const totalLines = this.model.getLineCount();
    let adjustedStart = Math.max(1, startLine);
    let adjustedEnd = Math.min(totalLines, endLine);

    // Check if startLine cuts into a block
    const startPos: Point = { row: adjustedStart - 1, column: 0 };
    const startNode = this.tree.rootNode.descendantForPosition(startPos);

    if (startNode) {
      // Find if we're cutting into a block
      let current: Node | null = startNode;
      while (current && current !== this.tree.rootNode) {
        if (this.isWholeBlockCandidate(current)) {
          const blockStartLine = current.startPosition.row + 1;
          const blockEndLine = current.endPosition.row + 1;

          // If our start line is in the middle of this block, include the whole block
          if (adjustedStart > blockStartLine && adjustedStart <= blockEndLine) {
            adjustedStart = blockStartLine;
            break;
          }
        }
        current = current.parent;
      }
    }

    // Check if endLine cuts into a block
    const endPos: Point = { row: adjustedEnd - 1, column: 0 };
    const endNode = this.tree.rootNode.descendantForPosition(endPos);

    if (endNode) {
      // Find if we're cutting into a block
      let current: Node | null = endNode;
      while (current && current !== this.tree.rootNode) {
        if (this.isWholeBlockCandidate(current)) {
          const blockStartLine = current.startPosition.row + 1;
          const blockEndLine = current.endPosition.row + 1;

          // If our end line is in the middle of this block, include the whole block
          if (adjustedEnd >= blockStartLine && adjustedEnd < blockEndLine) {
            adjustedEnd = blockEndLine;
            break;
          }
        }
        current = current.parent;
      }
    }

    return {
      startLine: Math.max(1, adjustedStart),
      endLine: Math.min(totalLines, adjustedEnd),
    };
  }

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
   * Expands a node to full line boundaries without including leading comments.
   * Ensures that extracted text never cuts lines in the middle to maintain readability.
   *
   * @param node Node to expand to full lines
   * @returns Range with start/end offsets aligned to line boundaries
   */
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

  /**
   * Gets the maximum column number for a given line
   */
  private lineEndColumn(lineNumber: number): number {
    return this.model.getLineMaxColumn(lineNumber);
  }

  /**
   * Gets the ending column position for a line, accounting for the actual line length.
   *
   * @param endOffset Character offset in the document
   * @returns Column number at the end of the line containing the offset
   */
  private lineEndColumnAtOffset(endOffset: number): number {
    const endPos = this.model.getPositionAt(endOffset);
    return this.lineEndColumn(endPos.lineNumber);
  }

  /**
   * Extracts the test title from a pm.test() call expression.
   * Parses AST node to find the first string argument of pm.test calls.
   * Handles simple template strings and strips quotes/backticks.
   *
   * @param node AST node to analyze (should be call_expression)
   * @returns Test title string or null if not a valid pm.test call
   */
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

  /**
   * Tokenizes a string into lowercase alphanumeric tokens for similarity analysis.
   * Removes special characters and splits on whitespace. Used for fuzzy matching
   * and semantic similarity scoring between code sections.
   *
   * @param s String to tokenize
   * @returns Array of lowercase alphanumeric tokens
   */
  private tokenize(s: string | null | undefined): string[] {
    if (!s) return [];
    return s
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  /**
   * Analyzes a node to find free identifiers (variables/functions used but not defined).
   * This helps determine dependencies between code sections for context ranking.
   * Collects identifiers that are read/called but excludes those defined within the node.
   *
   * @param node AST node to analyze
   * @returns Set of free identifier names
   */
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

  /**
   * Analyzes identifier usage frequency across the entire file.
   * Returns a map of identifier names to their usage count.
   *
   * @returns Map from identifier name to usage count
   */
  private analyzeGlobalUsageFrequency(): Map<string, number> {
    if (!this.tree) return new Map();

    const usageCount = new Map<string, number>();

    const countUsage = (node: Node) => {
      if (node.type === "identifier") {
        const parent = node.parent;
        const name = node.text;

        // Count as usage if it's not a definition site
        const isDef =
          (parent?.type === "variable_declarator" &&
            parent.firstNamedChild === node) ||
          (parent?.type === "function_declaration" &&
            parent.childForFieldName("name") === node) ||
          (parent?.type === "property_definition" &&
            parent.childForFieldName("key") === node);

        if (!isDef && name) {
          usageCount.set(name, (usageCount.get(name) || 0) + 1);
        }
      }

      // Recursively count in all children
      for (let i = 0; i < node.namedChildCount; i++) {
        countUsage(node.namedChild(i)!);
      }
    };

    countUsage(this.tree.rootNode);
    return usageCount;
  }

  /**
   * Gets identifiers that are called or read within a specific block scope.
   * Analyzes the current block and all its ancestors up to the topmost level.
   *
   * @param cursor Current cursor position
   * @returns Set of identifier names used in the current block scope
   */
  private getIdentifiersUsedInCurrentScope(cursor: Position): Set<string> {
    if (!this.tree) return new Set();

    const tsPos: Point = {
      row: cursor.lineNumber - 1,
      column: cursor.column - 1,
    };
    const nodeAtCursor = this.tree.rootNode.descendantForPosition(tsPos);

    if (!nodeAtCursor) return new Set();

    // Find the current enclosing block
    const enclosingBlock = this.getCurrentEnclosingBlock(cursor);
    if (!enclosingBlock) {
      // If at top level, analyze the entire file
      return new Set(this.analyzeGlobalUsageFrequency().keys());
    }

    // Get the topmost parent to define the scope boundary
    const topmostParent =
      this.topLevelAncestor(enclosingBlock) ?? enclosingBlock;

    // Collect all identifiers used within the topmost parent scope
    const usedIdentifiers = new Set<string>();

    const collectIdentifiers = (node: Node) => {
      if (node.type === "identifier") {
        const parent = node.parent;
        const name = node.text;

        // Count as usage if it's not a definition site
        const isDef =
          (parent?.type === "variable_declarator" &&
            parent.firstNamedChild === node) ||
          (parent?.type === "function_declaration" &&
            parent.childForFieldName("name") === node);

        if (!isDef && name) {
          usedIdentifiers.add(name);
        }
      }

      // Recursively collect from all children
      for (let i = 0; i < node.namedChildCount; i++) {
        collectIdentifiers(node.namedChild(i)!);
      }
    };

    collectIdentifiers(topmostParent);
    return usedIdentifiers;
  }

  /**
   * Builds an index mapping global identifier names to their defining block ranges.
   * This enables quick lookup of where variables and functions are defined
   * for dependency resolution during context extraction.
   *
   * @returns Map from identifier name to its defining BlockRange
   */
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

  /**
   * Expands selected blocks by including their dependencies (one-hop resolution).
   * Analyzes free identifiers in picked blocks and adds global definitions they reference.
   * Respects budget constraints to avoid including too much context.
   *
   * @param picked Currently selected block ranges
   * @param globalIndex Map of identifier names to their defining blocks
   * @param already Ranges already included in the context
   * @param budgetLeft Remaining character budget for additional context
   * @returns Expanded array of ranges including dependencies
   */
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

  /**
   * Collects all definitions (function names, variable names) exported by a block.
   * This helps identify what symbols a block makes available to other code.
   * Used for dependency analysis and avoiding duplicate definitions.
   *
   * @param n Block node to analyze for definitions
   * @returns Set of identifier names defined by this block
   */
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

  /**
   * Collects pm.test() call blocks excluding a specific range (usually Tier A).
   * Searches for test blocks in the global scope and returns them with metadata.
   * These form Tier B context in the ranking system.
   *
   * @param excludeRange Optional range to exclude from results (e.g., current context)
   * @returns Array of test block ranges with their AST nodes
   */
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

  /**
   * Creates a compact skeleton representation of a pm.test() call.
   * Useful for displaying test structure without full implementation details.
   * Extracts the test name from the first argument and shows simplified syntax.
   *
   * @param node AST node representing a pm.test() call
   * @returns Skeleton string like 'pm.test("testname", function () { ... });'
   */
  private renderTestSkeleton(node: Node): string {
    // try to pull the test name: pm.test("Name", ...)
    const arg0 = node.childForFieldName("arguments")?.namedChildren?.[0];
    const lit =
      arg0 && (arg0.type === "string" || arg0.type === "template_string")
        ? arg0.text
        : '"test"';
    return `pm.test(${lit}, function () { ... });`;
  }

  /**
   * Calculates character budgets for each tier based on total available characters.
   * Distributes the total budget according to percentage allocation for tiers A-D.
   *
   * @param totalChars Total character budget available
   * @param perc Percentage allocation for each tier (defaults to DEFAULT_TIER_PERCENTS)
   * @returns Budget object with character allocations for each tier
   */
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

  /**
   * Converts an array of offset ranges to concatenated text strings.
   * Extracts text from the Monaco model for each range and joins with newlines.
   * Ensures proper line boundaries and handles edge cases gracefully.
   *
   * @param ranges Array of character offset ranges to extract
   * @returns Concatenated text from all ranges
   */
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

  /**
   * Finds the test title from a pm.test() call near the cursor position.
   * Traverses up the AST to find the nearest function and checks if it's wrapped in a pm.test call.
   *
   * @param cursor Current cursor position
   * @returns Test title string or null if no pm.test call found
   */
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

  /**
   * Builds query tokens for similarity search from context around cursor.
   * Combines tokens from current line text, leading comments, and test titles.
   * These tokens are used for semantic matching with other code sections.
   *
   * @param cursor Current cursor position
   * @returns Array of tokenized strings for similarity analysis
   */
  private buildQueryTokens(cursor: Position): string[] {
    const line = this.getLineText(cursor.lineNumber);
    const cmt = this.leadingCommentTextAt(cursor.lineNumber);
    const title = this.getTestTitleNearCursor(cursor) ?? "";
    return [...cutTokenize(line), ...cutTokenize(cmt), ...cutTokenize(title)];
  }

  /**
   * Extracts name and comment tokens from a node for similarity analysis.
   * Gets function/variable names and leading comment text to build semantic tokens.
   * Used for ranking code sections based on textual similarity.
   *
   * @param n AST node to extract tokens from
   * @returns Array of name and comment tokens
   */
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

  /**
   * @deprecated Will be removed in next iteration
   * Calculates similarity score between query tokens and a node's content.
   * Uses Jaccard similarity with small bonuses for exact token matches.
   *
   * @param queryTokens Tokens from the query context
   * @param n Node to score for similarity
   * @returns Similarity score between 0 and 1
   */
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

  /**
   * Collects all top-level blocks in the file that are candidates for context extraction.
   * Includes functions, pm.test() calls, variable declarations, and other statements.
   * Categorizes each block by type for different ranking strategies.
   *
   * @returns Array of top-level blocks with their types and ranges
   */
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
  /**
   * Extracts tokens from the current editing context for similarity analysis.
   * If cursor is inside a function, extracts tokens from the entire function.
   * Otherwise, falls back to current line and associated comments.
   *
   * @param cursor Current cursor position
   * @returns Object with tokens array and the range they represent
   */
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
  /**
   * Filters items to exclude those that overlap with already taken ranges.
   * Used to prevent duplicate context extraction and ensure clean tier separation.
   *
   * @param items Array of items to filter
   * @param taken Array of already allocated ranges
   * @returns Filtered array with non-overlapping items only
   */
  private filterNonOverlapping<
    T extends { startOffset: number; endOffset: number }
  >(items: T[], taken: Array<{ startOffset: number; endOffset: number }>) {
    return items.filter((it) => !taken.some((t) => this.overlaps(it, t)));
  }

  /**
   * Reserves ranges to prevent overlap during ranked extraction
   * @param ranges Array of ranges to reserve
   */
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

  /**
   * Extracts ranked context sections organized into multiple tiers based on relevance.
   *
   * This advanced method provides a multi-tier context extraction system:
   * - Tier A (40%): Local context around cursor (current function/block)
   * - Tier B (30%): Global declarations and dependencies
   * - Tier C (20%): Relevant helper functions and utilities
   * - Tier D (10%): Other test blocks and compact skeletons
   *
   * Features:
   * - Smart dependency analysis and one-hop expansion
   * - Similarity-based ranking using Jaccard coefficients
   * - Budget management to stay within token limits
   * - Overlap prevention between tiers
   * - Rich debug information for analysis
   *
   * @param cursor Position in the code to extract context around
   * @param opts Configuration options including debug flag and tier percentages
   * @returns Ranked context sections with metadata and optional debug info
   *
   * @example
   * ```typescript
   * const ranked = extractor.getRankedContextSections(
   *   { lineNumber: 42, column: 10 },
   *   { debug: true, maxCharsBudget: 12000 }
   * );
   *
   * console.log('Tier A (Local):', ranked.linesAroundCursor);
   * console.log('Tier B (Globals):', ranked.declarations);
   * console.log('Tier C (Helpers):', ranked.relevantLines);
   * console.log('Tier D (Tests):', ranked.existingTests);
   *
   * if (ranked.debug) {
   *   console.log('Budget allocation:', ranked.debug.budgets);
   *   console.log('Scoring details:', ranked.debug.scored);
   * }
   * ```
   */
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
      rawPrefixLines: opts.rawPrefixLines ?? 5, // tune as you like
      rawSuffixLines: opts.rawSuffixLines ?? 5,
      maxCharsBudget: undefined, // irrelevant for raw lines
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
