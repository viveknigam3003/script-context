/**
 * @fileoverview Clean and Modular Context Extractor for JavaScript/TypeScript Code
 *
 * This module provides intelligent context extraction from code using Tree-sitter AST parsing.
 * It extracts relevant code context around a cursor position for use with Large Language Models (LLMs).
 *
 * Core Architecture:
 * The module is built around three main extraction methods that can be used independently or combined:
 *
 * 1. **Lines Around Cursor** (`getContextAroundCursor`):
 *    - Case (a): Cursor at top level - uses prefix/suffix lines with syntax sanity
 *    - Case (b): Cursor inside block - takes entire block + prefix/suffix from boundaries
 *
 * 2. **Global Declarations** (`getGlobalDeclarations`):
 *    - Priority 1: Declarations called/read in current block scope
 *    - Priority 2: Most used declarations across the file
 *    - Priority 3: Other available declarations if budget allows
 *
 * 3. **Relevant Blocks** (`getRelevantBlocks`):
 *    - Tokenizes current block line by line with camelCase/snake_case conversion
 *    - Uses Jaccard similarity to find top K most similar blocks
 *    - Maintains original file order for output
 *
 * Key Features:
 * - Clean, modular design with three independent extraction methods
 * - AST-aware context extraction with syntax sanity preservation
 * - Incremental parsing for performance
 * - Budget management to stay within token limits
 * - Support for Postman test scripts with pm.test() handling
 * - Comprehensive tokenization with stopword filtering
 *
 * @author Vivek Nigam
 * @version 2.0.0
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
 * Options for relevant blocks extraction
 */
export interface RelevantBlocksOptions {
  /**
   * Number of most similar blocks to return
   * @default 3
   */
  topK?: number;

  /**
   * Maximum number of characters to include for relevant blocks
   * @default 1500
   */
  maxCharsBudget?: number;

  /**
   * Whether to include leading comments with blocks
   * @default true
   */
  includeLeadingComments?: boolean;

  /**
   * Minimum similarity threshold (0-1) to include a block
   * @default 0.05
   */
  minSimilarityThreshold?: number;
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
 * Result of relevant blocks extraction
 */
export interface RelevantBlocksResult {
  /**
   * The extracted relevant blocks text
   */
  text: string;

  /**
   * Array of similar blocks included in the result
   */
  blocks: Array<{
    startOffset: number;
    endOffset: number;
    blockType: string;
    similarity: number;
    commonTokens: string[];
    totalTokens: number;
  }>;

  /**
   * Information about the current block that was used for comparison
   */
  currentBlock: {
    startOffset: number;
    endOffset: number;
    tokens: string[];
    blockType: string;
  };

  /**
   * Metadata about the extraction
   */
  meta: {
    totalBlocksAnalyzed: number;
    blocksAboveThreshold: number;
    topKSelected: number;
    budgetUsed: number;
    budgetLimit: number;
    averageSimilarity: number;
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

// ===== CONSTANTS =====

/** Default percentage allocation for different context tiers */
const DEFAULT_TIER_PERCENTS = { A: 0.4, B: 0.3, C: 0.2, D: 0.1 } as const;

// ===== UTILITY FUNCTIONS =====

/**
 * Splits camelCase and snake_case strings into individual words for tokenization.
 *
 * This function is essential for the tokenization strategy used in relevant blocks extraction.
 * It converts complex identifiers into searchable tokens that can be matched across code.
 *
 * @param s String to split (e.g., "userName", "user_name", "validateZipCode")
 * @returns Array of individual words in lowercase
 *
 * @example
 * ```typescript
 * splitCamelSnake("userName") // ["user", "Name"]
 * splitCamelSnake("user_name") // ["user", "name"]
 * splitCamelSnake("validateZipCode") // ["validate", "Zip", "Code"]
 * splitCamelSnake("pm.response.json") // ["pm", "response", "json"]
 * ```
 */
function splitCamelSnake(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // Split camelCase: "userName" -> "user Name"
    .replace(/[_\W]+/g, " ") // Replace underscores and non-word chars with spaces
    .split(/\s+/) // Split on whitespace
    .filter(Boolean); // Remove empty strings
}

/**
 * Tokenizes text into meaningful words, filters stopwords, and removes duplicates.
 *
 * This is the core tokenization function used throughout the context extraction process.
 * It's designed specifically for code analysis, handling programming constructs intelligently.
 *
 * Process:
 * 1. Converts to lowercase for case-insensitive matching
 * 2. Splits camelCase and snake_case using splitCamelSnake()
 * 3. Filters out single-character tokens (usually operators/punctuation)
 * 4. Removes common code stopwords (if, for, const, etc.)
 * 5. Deduplicates while preserving order
 *
 * @param raw Raw text to tokenize (code, comments, identifiers)
 * @param STOP Set of stopwords to filter out (defaults to CODE_STOPWORDS)
 * @returns Array of meaningful, deduplicated tokens
 *
 * @example
 * ```typescript
 * cutTokenize("const userName = pm.response.json().userName")
 * // Returns: ["user", "name", "pm", "response", "json"]
 *
 * cutTokenize("pm.test('Check for response body schema', function() {")
 * // Returns: ["pm", "test", "check", "response", "body", "schema", "function"]
 * ```
 */
function cutTokenize(
  raw: string,
  STOP: Set<string> = CODE_STOPWORDS
): string[] {
  if (!raw) return [];

  const out: string[] = [];
  // Process each word through camelCase/snake_case splitting
  for (const w of splitCamelSnake(raw.toLowerCase())) {
    if (w.length <= 1) continue; // Skip single characters (operators, etc.)
    if (STOP.has(w)) continue; // Skip common code keywords
    out.push(w);
  }

  // Deduplicate while preserving order for consistent results
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
 * Calculates Jaccard similarity coefficient between two sets of tokens.
 *
 * Jaccard similarity is the size of intersection divided by the size of union.
 * It's perfect for measuring similarity between code blocks based on shared tokens.
 *
 * Formula: J(A,B) = |A ∩ B| / |A ∪ B|
 *
 * @param a First set of tokens
 * @param b Second set of tokens
 * @returns Similarity score between 0 and 1 (0 = no similarity, 1 = identical)
 *
 * @example
 * ```typescript
 * const tokens1 = new Set(["user", "name", "validate"]);
 * const tokens2 = new Set(["user", "email", "validate"]);
 * const similarity = jaccard(tokens1, tokens2); // 0.5 (2 common / 4 total)
 * ```
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  // Handle empty sets - no similarity if both empty
  if (!a.size && !b.size) return 0;

  let inter = 0;
  // Performance optimization: iterate over smaller set
  const small = a.size <= b.size ? a : b;
  const big = a.size <= b.size ? b : a;

  // Count intersections
  small.forEach((t) => big.has(t) && inter++);

  // Return Jaccard coefficient: |intersection| / |union|
  return inter / (a.size + b.size - inter);
}

// ===== MAIN CLASS =====

/**
 * ContextExtractor provides intelligent, modular code context extraction using Tree-sitter AST parsing.
 *
 * This class offers three main extraction methods that can be used independently or combined:
 *
 * 1. **`getContextAroundCursor()`** - Extracts lines around cursor with syntax awareness
 * 2. **`getGlobalDeclarations()`** - Extracts prioritized global declarations
 * 3. **`getRelevantBlocks()`** - Extracts similar code blocks using token similarity
 * 4. **`getRankedContextSections()`** - Combines all three methods with budget allocation
 *
 * Architecture Benefits:
 * - **Modular**: Each method can be used independently
 * - **Configurable**: Extensive options for customization
 * - **Performant**: Incremental AST parsing with change tracking
 * - **Scalable**: Easy to add or remove extraction strategies
 * - **Type-safe**: Full TypeScript support with comprehensive interfaces
 *
 * @example Basic Usage
 * ```typescript
 * const extractor = await ContextExtractor.create(monacoModel);
 *
 * // Extract lines around cursor
 * const lines = extractor.getContextAroundCursor({ lineNumber: 42, column: 10 });
 *
 * // Extract global declarations
 * const declarations = extractor.getGlobalDeclarations({ lineNumber: 42, column: 10 });
 *
 * // Extract similar blocks
 * const similar = extractor.getRelevantBlocks({ lineNumber: 42, column: 10 });
 *
 * // Get comprehensive ranked context
 * const ranked = extractor.getRankedContextSections({ lineNumber: 42, column: 10 });
 * ```
 *
 * @example Advanced Configuration
 * ```typescript
 * const ranked = extractor.getRankedContextSections(cursor, {
 *   maxCharsBudget: 8000,
 *   tierPercents: { A: 0.5, B: 0.3, C: 0.2, D: 0.0 },
 *   includeLeadingComments: true,
 *   debug: true
 * });
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
    console.log("Tree rebuilt successfully\n", this.tree);
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
   * Checks for unbalanced parentheses/braces, incomplete declarations, and common unfinished patterns.
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

    // Count braces/parens (very lightweight; good enough for "unfinished")
    let paren = 0,
      brace = 0;
    for (const ch of text) {
      if (ch === "(") paren++;
      else if (ch === ")") paren = Math.max(0, paren - 1);
      else if (ch === "{") brace++;
      else if (ch === "}") brace = Math.max(0, brace - 1);
    }

    // Check current line for incomplete declarations
    const currentLine = this.model.getLineContent(cursor.lineNumber).trim();
    const hasIncompleteDeclaration =
      /^(const|let|var)\s*$/.test(currentLine) || // Just "const ", "let ", "var "
      /^(const|let|var)\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*$/.test(currentLine) || // "const identifier"
      /^function\s*$/.test(currentLine) || // Just "function "
      /^function\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*$/.test(currentLine); // "function name"

    // Extra hint: line looks like a starting construct w/o closure nearby
    const startsCallOrFn = /\b(pm\.test\s*\(|function\b|=>\s*\{?$)/.test(
      currentLine
    );

    return paren > 0 || brace > 0 || hasIncompleteDeclaration || startsCallOrFn;
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
   * Extracts relevant blocks/lines based on token similarity with the current block being edited.
   *
   * Tokenization strategy:
   * - Processes each line using delimiters (whitespace, operators, brackets, etc.)
   * - Converts camelCase and snake_case to individual words
   * - Filters out stopwords and very short tokens
   *
   * Similarity calculation:
   * - Uses Jaccard similarity between token sets
   * - Returns top K (default=3) most similar blocks
   * - Maintains original file order for output
   *
   * @param cursor Current cursor position to determine the editing context
   * @param opts Configuration options for extraction
   * @returns Relevant blocks result with similar blocks and metadata
   *
   * @example
   * ```typescript
   * const relevant = extractor.getRelevantBlocks(
   *   { lineNumber: 42, column: 10 },
   *   { topK: 3, minSimilarityThreshold: 0.2 }
   * );
   * console.log(`Found ${relevant.blocks.length} similar blocks`);
   * relevant.blocks.forEach(block => {
   *   console.log(`${block.blockType}: ${block.similarity.toFixed(2)} similarity`);
   * });
   * ```
   */
  public getRelevantBlocks(
    cursor: Position,
    opts: RelevantBlocksOptions = {}
  ): RelevantBlocksResult {
    this.ensureIncrementalParseUpToDate();

    const topK = opts.topK ?? 3;
    const maxBudget = opts.maxCharsBudget ?? 1500;
    const includeComments = opts.includeLeadingComments ?? true;
    const minThreshold = opts.minSimilarityThreshold ?? 0.05; // Lower threshold to include more blocks

    // Get the current block being edited
    const currentBlockInfo = this.getCurrentBlockForSimilarity(cursor);
    if (!currentBlockInfo) {
      return {
        text: "",
        blocks: [],
        currentBlock: {
          startOffset: 0,
          endOffset: 0,
          tokens: [],
          blockType: "unknown",
        },
        meta: {
          totalBlocksAnalyzed: 0,
          blocksAboveThreshold: 0,
          topKSelected: 0,
          budgetUsed: 0,
          budgetLimit: maxBudget,
          averageSimilarity: 0,
        },
      };
    }

    // Tokenize the current block
    const currentTokens = this.tokenizeBlockLineByLine(
      currentBlockInfo.startOffset,
      currentBlockInfo.endOffset
    );
    const currentTokenSet = new Set(currentTokens);

    // Get all other blocks for comparison
    const allBlocks = this.collectAllBlocksForSimilarity(currentBlockInfo);

    if (allBlocks.length === 0) {
      return {
        text: "",
        blocks: [],
        currentBlock: {
          startOffset: currentBlockInfo.startOffset,
          endOffset: currentBlockInfo.endOffset,
          tokens: currentTokens,
          blockType: currentBlockInfo.blockType,
        },
        meta: {
          totalBlocksAnalyzed: 0,
          blocksAboveThreshold: 0,
          topKSelected: 0,
          budgetUsed: 0,
          budgetLimit: maxBudget,
          averageSimilarity: 0,
        },
      };
    }

    // Calculate similarity for each block
    type ScoredBlock = {
      startOffset: number;
      endOffset: number;
      blockType: string;
      node: Node;
      similarity: number;
      tokens: string[];
      commonTokens: string[];
    };

    const scoredBlocks: ScoredBlock[] = [];

    for (const block of allBlocks) {
      const blockTokens = this.tokenizeBlockLineByLine(
        block.startOffset,
        block.endOffset
      );
      const blockTokenSet = new Set(blockTokens);

      // Calculate Jaccard similarity
      const similarity = jaccard(currentTokenSet, blockTokenSet);

      // Find common tokens for debugging
      const commonTokens = currentTokens.filter((token) =>
        blockTokenSet.has(token)
      );

      // Only include blocks above threshold
      if (similarity >= minThreshold) {
        scoredBlocks.push({
          startOffset: block.startOffset,
          endOffset: block.endOffset,
          blockType: block.blockType,
          node: block.node,
          similarity,
          tokens: blockTokens,
          commonTokens,
        });
      }
    }

    // Sort by similarity (highest first), then by file position
    scoredBlocks.sort((a, b) => {
      if (Math.abs(b.similarity - a.similarity) > 0.001) {
        return b.similarity - a.similarity;
      }
      return a.startOffset - b.startOffset;
    });

    // Select top K blocks within budget
    const selectedBlocks: ScoredBlock[] = [];
    let budgetUsed = 0;

    for (const block of scoredBlocks) {
      if (selectedBlocks.length >= topK) break;

      const blockSize = block.endOffset - block.startOffset;
      if (budgetUsed + blockSize <= maxBudget) {
        selectedBlocks.push(block);
        budgetUsed += blockSize;
      }
    }

    // Sort selected blocks by file order for output
    selectedBlocks.sort((a, b) => a.startOffset - b.startOffset);

    // Generate text ranges
    const ranges = selectedBlocks.map((block) => {
      const range = includeComments
        ? this.expandNodeToFullLinesWithLeadingComments(block.node)
        : this.expandNodeToFullLines(block.node);

      return {
        startOffset: range.startOffset,
        endOffset: range.endOffset,
        blockType: block.blockType,
        similarity: block.similarity,
        commonTokens: block.commonTokens,
        totalTokens: block.tokens.length,
      };
    });

    // Generate final text
    const text = this.textFromRanges(ranges);

    // Calculate metadata
    const totalSimilarities = scoredBlocks.reduce(
      (sum, block) => sum + block.similarity,
      0
    );
    const averageSimilarity =
      scoredBlocks.length > 0 ? totalSimilarities / scoredBlocks.length : 0;

    return {
      text,
      blocks: ranges,
      currentBlock: {
        startOffset: currentBlockInfo.startOffset,
        endOffset: currentBlockInfo.endOffset,
        tokens: currentTokens,
        blockType: currentBlockInfo.blockType,
      },
      meta: {
        totalBlocksAnalyzed: allBlocks.length,
        blocksAboveThreshold: scoredBlocks.length,
        topKSelected: selectedBlocks.length,
        budgetUsed,
        budgetLimit: maxBudget,
        averageSimilarity,
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
   * Tokenizes a block of code line by line using advanced tokenization strategy.
   * Converts camelCase and snake_case to individual words and uses delimiters.
   *
   * Example transformations:
   * - `const userName = pm.response.json().userName` → ["const", "user", "name", "pm", "response", "json"]
   * - `pm.test("Check for response body schema", function() {` → ["pm", "test", "check", "response", "body", "schema", "function"]
   *
   * @param startOffset Starting offset of the block
   * @param endOffset Ending offset of the block
   * @returns Array of tokens from all lines in the block
   */
  private tokenizeBlockLineByLine(
    startOffset: number,
    endOffset: number
  ): string[] {
    const startPos = this.model.getPositionAt(startOffset);
    const endPos = this.model.getPositionAt(endOffset);

    const allTokens: string[] = [];

    // Process each line in the block
    for (
      let lineNum = startPos.lineNumber;
      lineNum <= endPos.lineNumber;
      lineNum++
    ) {
      const lineContent = this.model.getLineContent(lineNum);
      const lineTokens = this.tokenizeLineWithDelimiters(lineContent);
      allTokens.push(...lineTokens);
    }

    // Remove duplicates while preserving order
    const seen = new Set<string>();
    const uniqueTokens: string[] = [];
    for (const token of allTokens) {
      if (!seen.has(token)) {
        seen.add(token);
        uniqueTokens.push(token);
      }
    }

    return uniqueTokens;
  }

  /**
   * Tokenizes a single line using delimiters and camelCase/snake_case conversion.
   * Applies the specific tokenization strategy requested.
   *
   * @param line Line of code to tokenize
   * @returns Array of tokens from the line
   */
  private tokenizeLineWithDelimiters(line: string): string[] {
    if (!line || !line.trim()) return [];

    // Remove comments first
    const cleanLine = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");

    // Define delimiters: whitespace, operators, brackets, quotes, etc.
    const delimiters = /[\s()[\]{}.;,=+\-*/!&|<>?:'"`,~@#$%^]+/g;

    // Split by delimiters and filter out empty strings
    const rawTokens = cleanLine.split(delimiters).filter(Boolean);

    const processedTokens: string[] = [];

    for (const token of rawTokens) {
      // Skip very short tokens and pure numbers
      if (token.length <= 1 || /^\d+$/.test(token)) continue;

      // Convert camelCase and snake_case to individual words
      const words = splitCamelSnake(token.toLowerCase());

      for (const word of words) {
        // Filter out stopwords and very short words
        if (word.length > 1 && !CODE_STOPWORDS.has(word)) {
          processedTokens.push(word);
        }
      }
    }

    return processedTokens;
  }

  /**
   * Gets the block type description for a given AST node.
   * Used for categorizing blocks in similarity analysis.
   *
   * @param node AST node to categorize
   * @returns Human-readable block type
   */
  private getBlockType(node: Node): string {
    switch (node.type) {
      case "function_declaration":
        return "function";
      case "lexical_declaration":
      case "variable_declaration":
        return "variable_declaration";
      case "call_expression": {
        // Check if it's a pm.test call
        const callee = node.child(0);
        if (callee?.type === "member_expression") {
          const obj = callee.child(0);
          const prop = callee.child(2);
          if (
            obj?.type === "identifier" &&
            obj.text === "pm" &&
            prop?.text === "test"
          ) {
            return "pm_test";
          }
        }
        return "function_call";
      }
      case "if_statement":
        return "if_statement";
      case "for_statement":
      case "for_in_statement":
      case "for_of_statement":
        return "loop";
      case "try_statement":
        return "try_catch";
      case "class_declaration":
        return "class";
      case "expression_statement":
        return "expression";
      default:
        return node.type;
    }
  }

  /**
   * Gets the current block being edited for similarity analysis.
   * Determines the appropriate block scope based on cursor position.
   *
   * @param cursor Current cursor position
   * @returns Block information or null if no suitable block found
   */
  private getCurrentBlockForSimilarity(cursor: Position): {
    startOffset: number;
    endOffset: number;
    blockType: string;
    node: Node;
  } | null {
    if (!this.tree) return null;

    const tsPos: Point = {
      row: cursor.lineNumber - 1,
      column: cursor.column - 1,
    };
    const nodeAtCursor = this.tree.rootNode.descendantForPosition(tsPos);

    if (!nodeAtCursor) return null;

    // Try to find the most appropriate block for similarity comparison
    // Priority: function > pm.test > class > control flow > expression statement
    let current: Node | null = nodeAtCursor;
    while (current && current !== this.tree.rootNode) {
      // Check for function-like blocks first (highest priority)
      if (this.isFunctionLike(current)) {
        const wrapped = this.wrapFunctionIfArgument(current);
        const range = this.expandNodeToFullLines(wrapped);
        return {
          startOffset: range.startOffset,
          endOffset: range.endOffset,
          blockType: this.getBlockType(wrapped),
          node: wrapped,
        };
      }

      // Check for other block types
      if (this.isWholeBlockCandidate(current)) {
        const container = this.wholeBlockContainer(current);
        const range = this.expandNodeToFullLines(container);
        return {
          startOffset: range.startOffset,
          endOffset: range.endOffset,
          blockType: this.getBlockType(container),
          node: container,
        };
      }

      current = current.parent;
    }

    // Fallback: use the nearest top-level statement
    const topLevel = this.topLevelAncestor(nodeAtCursor);
    if (topLevel) {
      const range = this.expandNodeToFullLines(topLevel);
      return {
        startOffset: range.startOffset,
        endOffset: range.endOffset,
        blockType: this.getBlockType(topLevel),
        node: topLevel,
      };
    }

    return null;
  }

  /**
   * Collects all blocks in the file that can be used for similarity comparison.
   * Excludes the current block to avoid self-comparison.
   *
   * @param currentBlock Information about the current block being edited
   * @returns Array of blocks available for similarity analysis
   */
  private collectAllBlocksForSimilarity(currentBlock: {
    startOffset: number;
    endOffset: number;
    blockType: string;
    node: Node;
  }): Array<{
    startOffset: number;
    endOffset: number;
    blockType: string;
    node: Node;
  }> {
    if (!this.tree) return [];

    const blocks: Array<{
      startOffset: number;
      endOffset: number;
      blockType: string;
      node: Node;
    }> = [];

    const root = this.tree.rootNode;

    // Collect all top-level blocks
    for (let i = 0; i < root.namedChildCount; i++) {
      const child = root.namedChild(i)!;

      if (!this.isWholeBlockCandidate(child)) continue;

      const container = this.wholeBlockContainer(child);
      const range = this.expandNodeToFullLines(container);

      // Skip the current block (avoid self-comparison)
      if (
        range.startOffset === currentBlock.startOffset &&
        range.endOffset === currentBlock.endOffset
      ) {
        continue;
      }

      // Skip very small blocks (single line or empty)
      const startLine = this.model.getPositionAt(range.startOffset).lineNumber;
      const endLine = this.model.getPositionAt(range.endOffset).lineNumber;
      if (endLine <= startLine) continue;

      blocks.push({
        startOffset: range.startOffset,
        endOffset: range.endOffset,
        blockType: this.getBlockType(container),
        node: container,
      });
    }

    // Also collect nested function blocks within other blocks
    const collectNestedFunctions = (node: Node, depth: number = 0) => {
      // Limit depth to avoid infinite recursion
      if (depth > 5) return;

      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i)!;

        if (this.isFunctionLike(child)) {
          const wrapped = this.wrapFunctionIfArgument(child);
          const range = this.expandNodeToFullLines(wrapped);

          // Skip the current block and duplicates
          const isDuplicate = blocks.some(
            (b) =>
              b.startOffset === range.startOffset &&
              b.endOffset === range.endOffset
          );
          const isCurrent =
            range.startOffset === currentBlock.startOffset &&
            range.endOffset === currentBlock.endOffset;

          if (!isDuplicate && !isCurrent) {
            // Check minimum size (must span multiple lines)
            const startLine = this.model.getPositionAt(
              range.startOffset
            ).lineNumber;
            const endLine = this.model.getPositionAt(
              range.endOffset
            ).lineNumber;
            if (endLine > startLine) {
              blocks.push({
                startOffset: range.startOffset,
                endOffset: range.endOffset,
                blockType: this.getBlockType(wrapped),
                node: wrapped,
              });
            }
          }
        }

        // Recursively check children
        collectNestedFunctions(child, depth + 1);
      }
    };

    collectNestedFunctions(root);

    // Sort by file position
    blocks.sort((a, b) => a.startOffset - b.startOffset);

    return blocks;
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
   * Also handles incomplete/unfinished declarations properly.
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

    // Check for incomplete declarations at the boundaries
    adjustedStart = this.adjustStartForIncompleteDeclarations(adjustedStart);
    adjustedEnd = this.adjustEndForIncompleteDeclarations(adjustedEnd);

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
   * Adjusts the start line to avoid cutting incomplete declarations.
   * Looks backward for incomplete const/let/var/function declarations.
   *
   * @param startLine Starting line to adjust
   * @returns Adjusted start line that doesn't cut incomplete declarations
   */
  private adjustStartForIncompleteDeclarations(startLine: number): number {
    let adjustedStart = startLine;

    // Look backward for incomplete declarations
    for (let line = startLine - 1; line >= Math.max(1, startLine - 3); line--) {
      const lineContent = this.model.getLineContent(line).trim();

      // Check for incomplete declarations (ending with keywords but no assignment/body)
      if (
        /^(const|let|var)\s*$/.test(lineContent) || // Just "const ", "let ", "var "
        /^(const|let|var)\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*$/.test(lineContent) || // "const identifier"
        /^function\s*$/.test(lineContent) || // Just "function "
        /^function\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*$/.test(lineContent) // "function name"
      ) {
        adjustedStart = line;
        continue;
      }

      // If we find a complete statement, stop looking backward
      if (
        lineContent.endsWith(";") ||
        lineContent.endsWith("}") ||
        lineContent.includes("=")
      ) {
        break;
      }

      // If line is empty or just whitespace, continue looking
      if (lineContent === "") {
        continue;
      }

      // If we find something else, stop
      break;
    }

    return adjustedStart;
  }

  /**
   * Adjusts the end line to include complete declarations after incomplete ones.
   * Looks forward to find the completion of incomplete declarations.
   *
   * @param endLine Ending line to adjust
   * @returns Adjusted end line that includes complete declarations
   */
  private adjustEndForIncompleteDeclarations(endLine: number): number {
    let adjustedEnd = endLine;
    const totalLines = this.model.getLineCount();

    // Check if the end line or lines before it have incomplete declarations
    for (let line = Math.max(1, endLine - 2); line <= endLine; line++) {
      const lineContent = this.model.getLineContent(line).trim();

      if (
        /^(const|let|var)\s*$/.test(lineContent) || // Just "const ", "let ", "var "
        /^(const|let|var)\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*$/.test(lineContent) || // "const identifier"
        /^function\s*$/.test(lineContent) || // Just "function "
        /^function\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*$/.test(lineContent) // "function name"
      ) {
        // Look forward to find the completion
        for (
          let nextLine = line + 1;
          nextLine <= Math.min(totalLines, line + 10);
          nextLine++
        ) {
          const nextContent = this.model.getLineContent(nextLine).trim();

          // Found completion - include it
          if (
            nextContent.includes("=") ||
            nextContent.includes("{") ||
            nextContent.endsWith(";")
          ) {
            adjustedEnd = Math.max(adjustedEnd, nextLine);
            break;
          }

          // Found another declaration or empty line - the incomplete one might be truly incomplete
          if (
            nextContent.match(/^(const|let|var|function)\s/) ||
            nextContent === ""
          ) {
            break;
          }
        }
      }
    }

    return adjustedEnd;
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

  // Ranking

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
   * Extracts comprehensive ranked context sections by combining all three main extraction methods.
   *
   * This method provides a clean, modular approach to context extraction by orchestrating
   * the three core methods with intelligent budget allocation:
   *
   * **Tier Allocation (Default: A=40%, B=30%, C=20%, D=10%)**:
   * - **Tier A**: Lines around cursor using `getContextAroundCursor()`
   * - **Tier B**: Global declarations using `getGlobalDeclarations()`
   * - **Tier C**: Relevant blocks using `getRelevantBlocks()`
   * - **Tier D**: Existing tests (placeholder for future extension)
   *
   * **Key Benefits**:
   * - **Modular Design**: Each tier uses a dedicated, well-tested method
   * - **Budget Management**: Intelligent character allocation across tiers
   * - **Independent Methods**: Each extraction method can be used standalone
   * - **Configurable**: Extensive options for customization
   * - **Extensible**: Easy to modify tier allocation or add new tiers
   *
   * @param cursor Position in the code to extract context around
   * @param opts Configuration options for budget, tiers, and debug information
   * @returns Comprehensive context sections with metadata and optional debug info
   *
   * @example Basic Usage
   * ```typescript
   * const ranked = extractor.getRankedContextSections(
   *   { lineNumber: 42, column: 10 },
   *   { maxCharsBudget: 8000 }
   * );
   *
   * console.log('Lines around cursor:', ranked.linesAroundCursor);
   * console.log('Global declarations:', ranked.declarations);
   * console.log('Relevant blocks:', ranked.relevantLines);
   * ```
   *
   * @example Advanced Configuration
   * ```typescript
   * const ranked = extractor.getRankedContextSections(cursor, {
   *   maxCharsBudget: 12000,
   *   tierPercents: { A: 0.5, B: 0.3, C: 0.2, D: 0.0 }, // Custom allocation
   *   rawPrefixLines: 10,
   *   rawSuffixLines: 10,
   *   includeLeadingComments: true,
   *   debug: true
   * });
   *
   * if (ranked.debug) {
   *   console.log('Budget allocation:', ranked.debug.budgets);
   *   console.log('Title tokens:', ranked.debug.titleTokens);
   * }
   * ```
   */
  public getRankedContextSections(
    cursor: Position,
    opts: RankedSectionsOptions = {}
  ): ExtractRankedContextSections {
    // Step 1: Calculate budget allocation for each tier based on percentages
    const totalBudget = Math.max(1000, opts.maxCharsBudget ?? 8000);
    const percents = opts.tierPercents ?? DEFAULT_TIER_PERCENTS;
    const budgets = this.deriveBudgets(totalBudget, percents);

    // Step 2: Initialize debug information structure for optional debugging
    const debug: DebugInfo = {
      budgets: { ...budgets, total: totalBudget },
      scored: { B: [], C: [] },
      picked: { B: [], C: [] },
      skipped: { B: [], C: [] },
      depsAdded: [],
    };

    // Step 3: Extract Tier A - Lines around cursor (40% of budget)
    // Uses the first main extraction method with syntax-aware line selection
    const linesAroundCursorResult = this.getContextAroundCursor(cursor, {
      numberOfPrefixLines: opts.rawPrefixLines ?? 5,
      numberOfSuffixLines: opts.rawSuffixLines ?? 5,
      includeLeadingComments: opts.includeLeadingComments ?? true,
    });

    // Step 4: Extract Tier B - Global declarations (30% of budget)
    // Uses the second main extraction method with priority-based selection
    const declarationsResult = this.getGlobalDeclarations(cursor, {
      maxCharsBudget: budgets.B,
      includeLeadingComments: opts.includeLeadingComments ?? true,
    });

    // Step 5: Extract Tier C - Relevant blocks (20% of budget)
    // Uses the third main extraction method with similarity-based selection
    const relevantBlocksResult = this.getRelevantBlocks(cursor, {
      topK: 3, // Limit to top 3 most similar blocks
      minSimilarityThreshold: 0.05, // Minimum Jaccard similarity
      maxCharsBudget: budgets.C,
      includeLeadingComments: opts.includeLeadingComments ?? true,
    });

    // Step 6: Extract Tier D - Existing tests (10% of budget, currently placeholder)
    // This tier is reserved for future extension with test skeleton extraction
    const existingTests = ""; // Can be extended with test skeleton extraction

    // Step 8: Deduplicate overlapping ranges across all tiers
    const rawExtractionResults = {
      linesAroundCursor: {
        text: linesAroundCursorResult.text,
        offsets: [
          {
            startOffset: linesAroundCursorResult.startOffset,
            endOffset: linesAroundCursorResult.endOffset,
          },
        ],
      },
      declarations: {
        text: declarationsResult.text,
        offsets: declarationsResult.declarations.map((d) => ({
          startOffset: d.startOffset,
          endOffset: d.endOffset,
        })),
      },
      relevantBlocks: {
        text: relevantBlocksResult.text,
        offsets: relevantBlocksResult.blocks.map((b) => ({
          startOffset: b.startOffset,
          endOffset: b.endOffset,
        })),
      },
      existingTests: {
        text: existingTests,
        offsets: [], // No test skeletons currently
      },
    };

    // Apply deduplication to prevent overlapping content
    const deduplicatedResults =
      this.deduplicateExtractionResults(rawExtractionResults);

    // Step 9: Build the comprehensive result structure with deduplicated content
    const result: ExtractRankedContextSections = {
      // Text content from each tier (now deduplicated)
      linesAroundCursor: deduplicatedResults.linesAroundCursor.text,
      declarations: deduplicatedResults.declarations.text,
      relevantLines: deduplicatedResults.relevantBlocks.text,
      existingTests: deduplicatedResults.existingTests.text,

      // Metadata for analysis and debugging
      meta: {
        strategy: linesAroundCursorResult.strategy,
        budgets,

        // Offset information for highlighting in editors (deduplicated)
        offsets: {
          A: deduplicatedResults.linesAroundCursor.offsets,
          B: deduplicatedResults.declarations.offsets,
          C: deduplicatedResults.relevantBlocks.offsets,
          D: deduplicatedResults.existingTests.offsets,
        },

        // Count information for analytics (updated with deduplicated counts)
        pickedCounts: {
          A: deduplicatedResults.linesAroundCursor.offsets.length,
          B: deduplicatedResults.declarations.offsets.length,
          C: deduplicatedResults.relevantBlocks.offsets.length,
          D: deduplicatedResults.existingTests.offsets.length,
          skeletons: deduplicatedResults.existingTests.offsets.length,
        },
      },

      // Include debug information only if requested
      debug: opts.debug ? debug : undefined,
    };

    // Step 10: Store debug information for later access via getLastDebug()
    this._lastDebug = opts.debug ? debug : null;

    return result;
  }

  /**
   * Deduplicates code blocks across multiple extraction results to prevent redundancy.
   *
   * This function ensures that the union of all extraction methods never contains duplicate
   * lines or blocks. It uses intelligent overlap detection and priority-based selection:
   *
   * **Priority Order** (higher priority wins):
   * 1. Tier A (Lines around cursor) - highest priority
   * 2. Tier B (Global declarations) - medium priority
   * 3. Tier C (Relevant blocks) - lowest priority
   * 4. Tier D (Existing tests) - lowest priority
   *
   * **Overlap Detection**:
   * - Line-level overlap detection for precise deduplication
   * - Partial overlap handling (removes overlapping portions)
   * - Maintains original block boundaries where possible
   *
   * @param extractionResults Object containing results from all extraction methods
   * @returns Deduplicated results with overlaps removed based on priority
   *
   * @example
   * ```typescript
   * const results = {
   *   linesAroundCursor: { text: "...", offsets: [...] },
   *   declarations: { text: "...", offsets: [...] },
   *   relevantBlocks: { text: "...", offsets: [...] },
   *   existingTests: { text: "...", offsets: [...] }
   * };
   *
   * const deduplicated = extractor.deduplicateExtractionResults(results);
   * // Returns: Same structure but with overlaps removed
   * ```
   */
  public deduplicateExtractionResults(extractionResults: {
    linesAroundCursor: {
      text: string;
      offsets: Array<{ startOffset: number; endOffset: number }>;
    };
    declarations: {
      text: string;
      offsets: Array<{ startOffset: number; endOffset: number }>;
    };
    relevantBlocks: {
      text: string;
      offsets: Array<{ startOffset: number; endOffset: number }>;
    };
    existingTests: {
      text: string;
      offsets: Array<{ startOffset: number; endOffset: number }>;
    };
  }): typeof extractionResults {
    // Step 1: Collect all ranges with their tier priorities
    type RangeWithPriority = {
      startOffset: number;
      endOffset: number;
      tier: "A" | "B" | "C" | "D";
      priority: number;
      originalIndex: number;
    };

    const allRanges: RangeWithPriority[] = [];

    // Add ranges with priority levels (higher number = higher priority)
    extractionResults.linesAroundCursor.offsets.forEach((range, idx) => {
      allRanges.push({ ...range, tier: "A", priority: 4, originalIndex: idx });
    });

    extractionResults.declarations.offsets.forEach((range, idx) => {
      allRanges.push({ ...range, tier: "B", priority: 3, originalIndex: idx });
    });

    extractionResults.relevantBlocks.offsets.forEach((range, idx) => {
      allRanges.push({ ...range, tier: "C", priority: 2, originalIndex: idx });
    });

    extractionResults.existingTests.offsets.forEach((range, idx) => {
      allRanges.push({ ...range, tier: "D", priority: 1, originalIndex: idx });
    });

    // Step 2: Sort by priority (highest first) then by file position
    allRanges.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.startOffset - b.startOffset;
    });

    // Step 3: Remove overlapping ranges (keep higher priority ones)
    const deduplicatedRanges: RangeWithPriority[] = [];

    for (const currentRange of allRanges) {
      let hasOverlap = false;

      // Check if current range overlaps with any already selected range
      for (const selectedRange of deduplicatedRanges) {
        if (this.rangesOverlap(currentRange, selectedRange)) {
          hasOverlap = true;
          break;
        }
      }

      // Only add if no overlap with higher priority ranges
      if (!hasOverlap) {
        deduplicatedRanges.push(currentRange);
      }
    }

    // Step 4: Group deduplicated ranges back by tier
    const groupedRanges = {
      A: deduplicatedRanges.filter((r) => r.tier === "A"),
      B: deduplicatedRanges.filter((r) => r.tier === "B"),
      C: deduplicatedRanges.filter((r) => r.tier === "C"),
      D: deduplicatedRanges.filter((r) => r.tier === "D"),
    };

    // Step 5: Reconstruct text for each tier using deduplicated ranges
    const reconstructText = (ranges: RangeWithPriority[]): string => {
      if (ranges.length === 0) return "";

      // Sort ranges by file position for proper text reconstruction
      const sortedRanges = ranges.sort((a, b) => a.startOffset - b.startOffset);

      const textParts: string[] = [];
      for (const range of sortedRanges) {
        const startPos = this.model.getPositionAt(range.startOffset);
        const endPos = this.model.getPositionAt(range.endOffset);

        const text = this.model.getValueInRange({
          startLineNumber: startPos.lineNumber,
          startColumn: 1, // Always start from beginning of line
          endLineNumber: endPos.lineNumber,
          endColumn: this.lineEndColumn(endPos.lineNumber),
        });

        textParts.push(text);
      }

      return textParts.join("\n");
    };

    // Step 6: Return deduplicated results in original structure
    return {
      linesAroundCursor: {
        text: reconstructText(groupedRanges.A),
        offsets: groupedRanges.A.map((r) => ({
          startOffset: r.startOffset,
          endOffset: r.endOffset,
        })),
      },
      declarations: {
        text: reconstructText(groupedRanges.B),
        offsets: groupedRanges.B.map((r) => ({
          startOffset: r.startOffset,
          endOffset: r.endOffset,
        })),
      },
      relevantBlocks: {
        text: reconstructText(groupedRanges.C),
        offsets: groupedRanges.C.map((r) => ({
          startOffset: r.startOffset,
          endOffset: r.endOffset,
        })),
      },
      existingTests: {
        text: reconstructText(groupedRanges.D),
        offsets: groupedRanges.D.map((r) => ({
          startOffset: r.startOffset,
          endOffset: r.endOffset,
        })),
      },
    };
  }

  /**
   * Convenience method to get deduplicated context by calling individual extraction methods.
   *
   * This method allows you to get deduplicated results without using getRankedContextSections,
   * giving you full control over the extraction parameters for each method.
   *
   * @param cursor Position in the code to extract context around
   * @param options Configuration for each extraction method
   * @returns Deduplicated results from all extraction methods
   *
   * @example
   * ```typescript
   * const deduplicated = extractor.getDeduplicatedContext(cursor, {
   *   linesAroundCursor: { numberOfPrefixLines: 10, numberOfSuffixLines: 10 },
   *   declarations: { maxCharsBudget: 1000 },
   *   relevantBlocks: { topK: 5, minSimilarityThreshold: 0.1 }
   * });
   * ```
   */
  public getDeduplicatedContext(
    cursor: Position,
    options: {
      linesAroundCursor?: ContextOptions;
      declarations?: GlobalDeclarationsOptions;
      relevantBlocks?: RelevantBlocksOptions;
    } = {}
  ): {
    linesAroundCursor: string;
    declarations: string;
    relevantBlocks: string;
    existingTests: string;
    meta: {
      offsets: {
        A: Array<{ startOffset: number; endOffset: number }>;
        B: Array<{ startOffset: number; endOffset: number }>;
        C: Array<{ startOffset: number; endOffset: number }>;
        D: Array<{ startOffset: number; endOffset: number }>;
      };
      originalCounts: { A: number; B: number; C: number; D: number };
      deduplicatedCounts: { A: number; B: number; C: number; D: number };
    };
  } {
    // Extract using individual methods with custom options
    const linesResult = this.getContextAroundCursor(
      cursor,
      options.linesAroundCursor ?? {}
    );
    const declarationsResult = this.getGlobalDeclarations(
      cursor,
      options.declarations ?? {}
    );
    const relevantResult = this.getRelevantBlocks(
      cursor,
      options.relevantBlocks ?? {}
    );

    // Prepare extraction results for deduplication
    const rawResults = {
      linesAroundCursor: {
        text: linesResult.text,
        offsets: [
          {
            startOffset: linesResult.startOffset,
            endOffset: linesResult.endOffset,
          },
        ],
      },
      declarations: {
        text: declarationsResult.text,
        offsets: declarationsResult.declarations.map((d) => ({
          startOffset: d.startOffset,
          endOffset: d.endOffset,
        })),
      },
      relevantBlocks: {
        text: relevantResult.text,
        offsets: relevantResult.blocks.map((b) => ({
          startOffset: b.startOffset,
          endOffset: b.endOffset,
        })),
      },
      existingTests: {
        text: "", // Placeholder for future extension
        offsets: [],
      },
    };

    // Apply deduplication
    const deduplicatedResults = this.deduplicateExtractionResults(rawResults);

    // Return clean structure
    return {
      linesAroundCursor: deduplicatedResults.linesAroundCursor.text,
      declarations: deduplicatedResults.declarations.text,
      relevantBlocks: deduplicatedResults.relevantBlocks.text,
      existingTests: deduplicatedResults.existingTests.text,
      meta: {
        offsets: {
          A: deduplicatedResults.linesAroundCursor.offsets,
          B: deduplicatedResults.declarations.offsets,
          C: deduplicatedResults.relevantBlocks.offsets,
          D: deduplicatedResults.existingTests.offsets,
        },
        originalCounts: {
          A: rawResults.linesAroundCursor.offsets.length,
          B: rawResults.declarations.offsets.length,
          C: rawResults.relevantBlocks.offsets.length,
          D: rawResults.existingTests.offsets.length,
        },
        deduplicatedCounts: {
          A: deduplicatedResults.linesAroundCursor.offsets.length,
          B: deduplicatedResults.declarations.offsets.length,
          C: deduplicatedResults.relevantBlocks.offsets.length,
          D: deduplicatedResults.existingTests.offsets.length,
        },
      },
    };
  }

  /**
   * Checks if two ranges overlap in the code.
   *
   * @param a First range to check
   * @param b Second range to check
   * @returns True if ranges overlap, false otherwise
   */
  private rangesOverlap(
    a: { startOffset: number; endOffset: number },
    b: { startOffset: number; endOffset: number }
  ): boolean {
    // Ranges overlap if one starts before the other ends
    return !(a.endOffset <= b.startOffset || a.startOffset >= b.endOffset);
  }
}
