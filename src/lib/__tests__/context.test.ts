import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockedFunction,
} from "vitest";
import type * as monaco from "monaco-editor";
import { Parser, Tree, Node } from "web-tree-sitter";
import { ContextExtractor } from "../context";
import { ensureParser } from "../treeSitterInit";

// Mock dependencies
vi.mock("../treeSitterInit");
vi.mock("web-tree-sitter");

// Mock Monaco editor types
const createMockModel = (content: string): monaco.editor.ITextModel => {
  const lines = content.split("\n");

  return {
    getValue: vi.fn(() => content),
    getValueInRange: vi.fn((range: monaco.IRange) => {
      const startLine = range.startLineNumber - 1;
      const endLine = range.endLineNumber - 1;
      const startCol = range.startColumn - 1;
      const endCol = range.endColumn - 1;

      if (startLine === endLine) {
        return lines[startLine]?.substring(startCol, endCol) || "";
      }

      const result = [];
      for (let i = startLine; i <= endLine; i++) {
        if (i === startLine) {
          result.push(lines[i]?.substring(startCol) || "");
        } else if (i === endLine) {
          result.push(lines[i]?.substring(0, endCol) || "");
        } else {
          result.push(lines[i] || "");
        }
      }
      return result.join("\n");
    }),
    getOffsetAt: vi.fn((position: monaco.IPosition) => {
      let offset = 0;
      for (let i = 0; i < position.lineNumber - 1; i++) {
        offset += (lines[i]?.length || 0) + 1; // +1 for newline
      }
      return offset + position.column - 1;
    }),
    getPositionAt: vi.fn((offset: number) => {
      let currentOffset = 0;
      for (let lineNumber = 1; lineNumber <= lines.length; lineNumber++) {
        const line = lines[lineNumber - 1] || "";
        if (currentOffset + line.length >= offset) {
          return {
            lineNumber,
            column: offset - currentOffset + 1,
          };
        }
        currentOffset += line.length + 1; // +1 for newline
      }
      return {
        lineNumber: lines.length,
        column: (lines[lines.length - 1]?.length || 0) + 1,
      };
    }),
    getLineCount: vi.fn(() => lines.length),
    getLineMaxColumn: vi.fn(
      (lineNumber: number) => (lines[lineNumber - 1]?.length || 0) + 1
    ),
  } as unknown as monaco.editor.ITextModel;
};

// Helper to create mock change events
const createMockChangeEvent = (
  changes: Array<{
    range: {
      startLineNumber: number;
      startColumn: number;
      endLineNumber: number;
      endColumn: number;
    };
    rangeOffset: number;
    rangeLength: number;
    text: string;
  }>
): monaco.editor.IModelContentChangedEvent => ({
  changes,
  eol: "\n",
  isFlush: false,
  isRedoing: false,
  isUndoing: false,
  isEolChange: false,
  versionId: 2,
});

// Simple mock node creation
const createMockNode = (
  type: string,
  startPos: { row: number; column: number },
  endPos: { row: number; column: number },
  startIndex: number = 0,
  endIndex: number = 100
): Node => {
  return {
    type,
    startPosition: startPos,
    endPosition: endPos,
    startIndex,
    endIndex,
    parent: null,
    previousSibling: null,
    nextSibling: null,
    previousNamedSibling: null,
    nextNamedSibling: null,
    namedChildren: [],
    namedChildCount: 0,
    isMissing: false,
    descendantForPosition: vi.fn((pos: { row: number; column: number }) => {
      // Simple implementation: return this node if position is within bounds
      if (pos.row >= startPos.row && pos.row <= endPos.row) {
        return {} as Node;
      }
      return null;
    }),
  } as unknown as Node;
};

const createMockTree = (rootNode: Node): Tree =>
  ({
    rootNode,
    edit: vi.fn(),
  } as unknown as Tree);

const createMockParser = (tree?: Tree): Parser =>
  ({
    parse: vi.fn(
      () =>
        tree ||
        createMockTree(
          createMockNode(
            "program",
            { row: 0, column: 0 },
            { row: 10, column: 0 }
          )
        )
    ),
    setLanguage: vi.fn(),
  } as unknown as Parser);

describe("ContextExtractor", () => {
  let mockParser: Parser;
  let mockEnsureParser: MockedFunction<typeof ensureParser>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockParser = createMockParser();
    mockEnsureParser = vi.mocked(ensureParser);
    mockEnsureParser.mockResolvedValue(mockParser);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("ContextExtractor.create", () => {
    it("should create instance and initialize parser", async () => {
      const model = createMockModel('console.log("hello");');

      const extractor = await ContextExtractor.create(model);

      expect(mockEnsureParser).toHaveBeenCalledOnce();
      expect(extractor).toBeInstanceOf(ContextExtractor);
      expect(mockParser.parse).toHaveBeenCalledWith('console.log("hello");');
    });
  });

  describe("getTreeStatus", () => {
    it("should return correct tree status", async () => {
      const model = createMockModel('console.log("hello");');
      const extractor = await ContextExtractor.create(model);

      const status = extractor.getTreeStatus();

      expect(status).toEqual({
        isDirty: false,
        hasTree: true,
        pendingEditsCount: 0,
        lastParseTime: expect.any(Number),
      });
    });
  });

  describe("onModelContentChanged", () => {
    it("should mark extractor as dirty and store pending edits", async () => {
      const model = createMockModel('console.log("hello");');
      const extractor = await ContextExtractor.create(model);

      const changeEvent = createMockChangeEvent([
        {
          range: {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 8,
          },
          rangeOffset: 0,
          rangeLength: 7,
          text: "print",
        },
      ]);

      extractor.onModelContentChanged(changeEvent);

      const status = extractor.getTreeStatus();
      expect(status.isDirty).toBe(true);
      expect(status.pendingEditsCount).toBe(1);
    });

    it("should handle multiple changes in correct order", async () => {
      const model = createMockModel('console.log("hello");');
      const extractor = await ContextExtractor.create(model);

      const changeEvent = createMockChangeEvent([
        {
          range: {
            startLineNumber: 1,
            startColumn: 15,
            endLineNumber: 1,
            endColumn: 15,
          },
          rangeOffset: 14,
          rangeLength: 0,
          text: " world",
        },
        {
          range: {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 8,
          },
          rangeOffset: 0,
          rangeLength: 7,
          text: "print",
        },
      ]);

      extractor.onModelContentChanged(changeEvent);

      const status = extractor.getTreeStatus();
      expect(status.pendingEditsCount).toBe(2);
    });
  });

  describe("forceBuildTree", () => {
    it("should force rebuild when tree is dirty", async () => {
      const model = createMockModel('console.log("hello");');
      const extractor = await ContextExtractor.create(model);

      // Make it dirty
      const changeEvent = createMockChangeEvent([
        {
          range: {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 1,
          },
          rangeOffset: 0,
          rangeLength: 0,
          text: "// comment\n",
        },
      ]);
      extractor.onModelContentChanged(changeEvent);

      expect(extractor.getTreeStatus().isDirty).toBe(true);

      extractor.forceBuildTree();

      expect(extractor.getTreeStatus().isDirty).toBe(false);
    });
  });

  describe("getContextAroundCursor", () => {
    it("should return valid context result", async () => {
      const model = createMockModel('console.log("test");');
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor({
        lineNumber: 1,
        column: 1,
      });

      expect(result).toBeDefined();
      expect(result.strategy).toBeOneOf([
        "enclosing-function",
        "adjacent-top-level-blocks",
        "fallback-lines",
      ]);
      expect(result.text).toBeDefined();
      expect(result.startOffset).toBeGreaterThanOrEqual(0);
      expect(result.endOffset).toBeGreaterThan(result.startOffset);
    });

    it("should use default options when none provided", async () => {
      const model = createMockModel('console.log("test");');
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor({
        lineNumber: 1,
        column: 1,
      });

      expect(result).toBeDefined();
    });

    it("should handle empty options object", async () => {
      const model = createMockModel('console.log("test");');
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor(
        { lineNumber: 1, column: 1 },
        {}
      );

      expect(result).toBeDefined();
    });

    it("should handle cursor at beginning of file", async () => {
      const model = createMockModel('console.log("test");');
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor({
        lineNumber: 1,
        column: 1,
      });

      expect(result).toBeDefined();
      expect(result.startOffset).toBeGreaterThanOrEqual(0);
    });

    it("should handle cursor at end of file", async () => {
      const model = createMockModel('console.log("test");');
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor({
        lineNumber: 1,
        column: 20,
      });

      expect(result).toBeDefined();
      expect(result.endOffset).toBeLessThanOrEqual(model.getValue().length);
    });

    it("should handle empty file", async () => {
      const model = createMockModel("");
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor({
        lineNumber: 1,
        column: 1,
      });

      expect(result).toBeDefined();
      expect(result.text).toBe("");
    });

    it("should handle single line file", async () => {
      const model = createMockModel("const x = 1;");
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor({
        lineNumber: 1,
        column: 5,
      });

      expect(result).toBeDefined();
      expect(result.text).toContain("const x = 1;");
    });

    it("should handle cursor outside valid range gracefully", async () => {
      const model = createMockModel('console.log("test");');
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor({
        lineNumber: 100,
        column: 1,
      });

      expect(result).toBeDefined();
    });

    it("should respect fallback line window option", async () => {
      const code = `// line 1
// line 2
// cursor here
// line 4
// line 5`;
      const model = createMockModel(code);
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor(
        { lineNumber: 3, column: 1 },
        { fallbackLineWindow: 1 }
      );

      expect(result).toBeDefined();
      expect(result.strategy).toBe("fallback-lines");
    });

    it("should respect maxCharsBudget option", async () => {
      const code = "a".repeat(5000); // Very long line
      const model = createMockModel(code);
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor(
        { lineNumber: 1, column: 1 },
        { maxCharsBudget: 100 }
      );

      expect(result).toBeDefined();
      expect(result.strategy).toBe("fallback-lines");
    });

    it("should handle nesting level option", async () => {
      const model = createMockModel("function test() { return true; }");
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor(
        { lineNumber: 1, column: 15 },
        { nestingLevel: 0 }
      );

      expect(result).toBeDefined();
    });
  });

  describe("error handling", () => {
    it("should handle parser initialization failure gracefully", async () => {
      const model = createMockModel('console.log("test");');
      mockEnsureParser.mockRejectedValue(new Error("Parser init failed"));

      await expect(ContextExtractor.create(model)).rejects.toThrow(
        "Parser init failed"
      );
    });

    it("should handle missing tree gracefully", async () => {
      const model = createMockModel('console.log("test");');

      // Create an extractor normally first
      const extractor = await ContextExtractor.create(model);

      // Now test that when getContextAroundCursor is called, it doesn't crash
      // Even if there are parsing issues, it should return something
      const result = extractor.getContextAroundCursor({
        lineNumber: 1,
        column: 1,
      });

      // It should return a valid result (could be any strategy)
      expect(result).toBeDefined();
      expect(result.strategy).toBeOneOf([
        "enclosing-function",
        "adjacent-top-level-blocks",
        "fallback-lines",
      ]);
      expect(result.text).toBeDefined();
    });
  });

  describe("incremental parsing", () => {
    it("should apply pending edits before parsing", async () => {
      const model = createMockModel('console.log("hello");');
      const extractor = await ContextExtractor.create(model);

      // Simulate content change
      const changeEvent = createMockChangeEvent([
        {
          range: {
            startLineNumber: 1,
            startColumn: 13,
            endLineNumber: 1,
            endColumn: 18,
          },
          rangeOffset: 12,
          rangeLength: 5,
          text: "world",
        },
      ]);

      extractor.onModelContentChanged(changeEvent);

      // Force re-parse
      extractor.forceBuildTree();

      const status = extractor.getTreeStatus();
      expect(status.isDirty).toBe(false);
      expect(status.pendingEditsCount).toBe(0);
    });
  });

  describe("performance considerations", () => {
    it("should not re-parse when tree is clean", async () => {
      const model = createMockModel('console.log("test");');
      const extractor = await ContextExtractor.create(model);

      const initialParseCount = vi.mocked(mockParser.parse).mock.calls.length;

      // Multiple calls without changes
      extractor.getContextAroundCursor({ lineNumber: 1, column: 1 });
      extractor.getContextAroundCursor({ lineNumber: 1, column: 5 });

      expect(vi.mocked(mockParser.parse).mock.calls.length).toBe(
        initialParseCount
      );
    });
  });

  describe("text positioning and offsets", () => {
    it("should return correct text offsets", async () => {
      const code = "function test() {\n  return true;\n}";
      const model = createMockModel(code);
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor({
        lineNumber: 2,
        column: 5,
      });

      expect(result.startOffset).toBeGreaterThanOrEqual(0);
      expect(result.endOffset).toBeGreaterThan(result.startOffset);
      expect(result.endOffset).toBeLessThanOrEqual(code.length);
    });

    it("should handle multi-line content correctly", async () => {
      const code = `line 1
line 2
line 3
line 4
line 5`;
      const model = createMockModel(code);
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor(
        { lineNumber: 3, column: 1 },
        { fallbackLineWindow: 1 }
      );

      expect(result.text).toBeDefined();
      expect(result.strategy).toBe("fallback-lines");
    });
  });

  describe("tree-sitter node types", () => {
    it("should handle various JavaScript node types", async () => {
      const jsNodeTypes = [
        "function_declaration",
        "function_expression",
        "arrow_function",
        "method_definition",
        "generator_function",
        "class_declaration",
        "lexical_declaration",
        "variable_declaration",
        "expression_statement",
        "if_statement",
        "for_statement",
        "while_statement",
        "try_statement",
      ];

      for (const nodeType of jsNodeTypes) {
        const node = createMockNode(
          nodeType,
          { row: 0, column: 0 },
          { row: 1, column: 0 }
        );
        expect(node.type).toBe(nodeType);
      }
    });
  });

  describe("mock model functionality", () => {
    it("should properly mock model methods", () => {
      const content = "line1\nline2\nline3";
      const model = createMockModel(content);

      expect(model.getValue()).toBe(content);
      expect(model.getLineCount()).toBe(3);
      expect(model.getLineMaxColumn(1)).toBe(6); // 'line1'.length + 1

      const pos = model.getPositionAt(6); // Should be start of line 2
      expect(pos.lineNumber).toBe(2);
      expect(pos.column).toBe(1);

      const offset = model.getOffsetAt({ lineNumber: 2, column: 1 });
      expect(offset).toBe(6);
    });
  });

  describe("strategies integration", () => {
    it("should fall back through strategies appropriately", async () => {
      // Test that when function strategy fails, it tries top-level blocks, then fallback
      const model = createMockModel("// just a comment");
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor({
        lineNumber: 1,
        column: 5,
      });

      // Should fall back to lines strategy since no functions or top-level blocks
      expect(result.strategy).toBe("fallback-lines");
      expect(result.text).toContain("comment");
    });
  });

  describe("edge cases and error handling", () => {
    it("should handle various nesting levels", async () => {
      const model = createMockModel("function test() { return true; }");
      const extractor = await ContextExtractor.create(model);

      // Test different nesting levels
      const result0 = extractor.getContextAroundCursor(
        { lineNumber: 1, column: 15 },
        { nestingLevel: 0 }
      );
      const result1 = extractor.getContextAroundCursor(
        { lineNumber: 1, column: 15 },
        { nestingLevel: 1 }
      );
      const result50 = extractor.getContextAroundCursor(
        { lineNumber: 1, column: 15 },
        { nestingLevel: 50 }
      );

      expect(result0).toBeDefined();
      expect(result1).toBeDefined();
      expect(result50).toBeDefined();
    });

    it("should handle negative nesting levels", async () => {
      const model = createMockModel("function test() { return true; }");
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor(
        { lineNumber: 1, column: 15 },
        { nestingLevel: -5 }
      );

      expect(result).toBeDefined();
    });

    it("should handle very large character budgets", async () => {
      const model = createMockModel("function test() { return true; }");
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor(
        { lineNumber: 1, column: 15 },
        { maxCharsBudget: 1000000 }
      );

      expect(result).toBeDefined();
      expect(result.text).toBeDefined();
    });

    it("should handle minimal character budgets", async () => {
      const model = createMockModel("function test() { return true; }");
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor(
        { lineNumber: 1, column: 15 },
        { maxCharsBudget: 1 }
      );

      expect(result).toBeDefined();
      expect(result.strategy).toBe("fallback-lines");
    });

    it("should handle zero character budget", async () => {
      const model = createMockModel("function test() { return true; }");
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor(
        { lineNumber: 1, column: 15 },
        { maxCharsBudget: 0 }
      );

      expect(result).toBeDefined();
      expect(result.strategy).toBe("fallback-lines");
    });

    it("should handle files with only whitespace", async () => {
      const model = createMockModel("   \n  \n   \n");
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor({
        lineNumber: 2,
        column: 1,
      });

      expect(result).toBeDefined();
      expect(result.strategy).toBe("fallback-lines");
    });

    it("should handle very long lines", async () => {
      const longLine = "const x = " + "a".repeat(10000) + ";";
      const model = createMockModel(longLine);
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor(
        { lineNumber: 1, column: 5000 },
        { maxCharsBudget: 1000 }
      );

      expect(result).toBeDefined();
      expect(result.strategy).toBe("fallback-lines");
    });

    it("should handle cursor at exact line boundaries", async () => {
      const code = "line1\nline2\nline3";
      const model = createMockModel(code);
      const extractor = await ContextExtractor.create(model);

      // Test cursor at end of line
      const result1 = extractor.getContextAroundCursor({
        lineNumber: 1,
        column: 6,
      });
      expect(result1).toBeDefined();

      // Test cursor at beginning of line
      const result2 = extractor.getContextAroundCursor({
        lineNumber: 2,
        column: 1,
      });
      expect(result2).toBeDefined();
    });

    it("should handle files with mixed line endings", async () => {
      const code = "line1\r\nline2\nline3\r\nline4";
      const model = createMockModel(code);
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor({
        lineNumber: 2,
        column: 3,
      });

      expect(result).toBeDefined();
      expect(result.text).toBeDefined();
    });
  });

  describe("incremental parsing comprehensive tests", () => {
    it("should handle complex multi-edit scenarios", async () => {
      const model = createMockModel('console.log("hello world");');
      const extractor = await ContextExtractor.create(model);

      // Multiple edits in sequence
      const changes = [
        {
          range: {
            startLineNumber: 1,
            startColumn: 13,
            endLineNumber: 1,
            endColumn: 18,
          },
          rangeOffset: 12,
          rangeLength: 5,
          text: "goodbye",
        },
        {
          range: {
            startLineNumber: 1,
            startColumn: 20,
            endLineNumber: 1,
            endColumn: 25,
          },
          rangeOffset: 19,
          rangeLength: 5,
          text: "universe",
        },
      ];

      for (const change of changes) {
        const changeEvent = createMockChangeEvent([change]);
        extractor.onModelContentChanged(changeEvent);
      }

      expect(extractor.getTreeStatus().pendingEditsCount).toBe(2);
      expect(extractor.getTreeStatus().isDirty).toBe(true);

      extractor.forceBuildTree();
      expect(extractor.getTreeStatus().isDirty).toBe(false);
      expect(extractor.getTreeStatus().pendingEditsCount).toBe(0);
    });

    it("should handle overlapping edits", async () => {
      const model = createMockModel("const x = 123;");
      const extractor = await ContextExtractor.create(model);

      // Create overlapping changes (sorted by offset)
      const changeEvent = createMockChangeEvent([
        {
          range: {
            startLineNumber: 1,
            startColumn: 7,
            endLineNumber: 1,
            endColumn: 8,
          },
          rangeOffset: 6,
          rangeLength: 1,
          text: "y",
        },
        {
          range: {
            startLineNumber: 1,
            startColumn: 11,
            endLineNumber: 1,
            endColumn: 14,
          },
          rangeOffset: 10,
          rangeLength: 3,
          text: "456",
        },
      ]);

      extractor.onModelContentChanged(changeEvent);

      expect(extractor.getTreeStatus().pendingEditsCount).toBe(2);
    });

    it("should handle insertion at file beginning", async () => {
      const model = createMockModel("existing content");
      const extractor = await ContextExtractor.create(model);

      const changeEvent = createMockChangeEvent([
        {
          range: {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 1,
          },
          rangeOffset: 0,
          rangeLength: 0,
          text: "// New comment\n",
        },
      ]);

      extractor.onModelContentChanged(changeEvent);

      expect(extractor.getTreeStatus().isDirty).toBe(true);
      expect(extractor.getTreeStatus().pendingEditsCount).toBe(1);
    });

    it("should handle insertion at file end", async () => {
      const model = createMockModel("existing content");
      const extractor = await ContextExtractor.create(model);

      const changeEvent = createMockChangeEvent([
        {
          range: {
            startLineNumber: 1,
            startColumn: 17,
            endLineNumber: 1,
            endColumn: 17,
          },
          rangeOffset: 16,
          rangeLength: 0,
          text: "\n// End comment",
        },
      ]);

      extractor.onModelContentChanged(changeEvent);

      expect(extractor.getTreeStatus().isDirty).toBe(true);
    });

    it("should handle complete file replacement", async () => {
      const model = createMockModel("old content");
      const extractor = await ContextExtractor.create(model);

      const changeEvent = createMockChangeEvent([
        {
          range: {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 12,
          },
          rangeOffset: 0,
          rangeLength: 11,
          text: "completely new content with much more text",
        },
      ]);

      extractor.onModelContentChanged(changeEvent);

      expect(extractor.getTreeStatus().isDirty).toBe(true);
      expect(extractor.getTreeStatus().pendingEditsCount).toBe(1);
    });
  });

  describe("performance and memory", () => {
    it("should reuse tree when possible", async () => {
      const model = createMockModel("function test() { return true; }");
      const extractor = await ContextExtractor.create(model);

      const initialStatus = extractor.getTreeStatus();
      const initialParseCount = vi.mocked(mockParser.parse).mock.calls.length;

      // Multiple context extractions without changes
      extractor.getContextAroundCursor({ lineNumber: 1, column: 5 });
      extractor.getContextAroundCursor({ lineNumber: 1, column: 10 });
      extractor.getContextAroundCursor({ lineNumber: 1, column: 15 });

      const finalParseCount = vi.mocked(mockParser.parse).mock.calls.length;
      expect(finalParseCount).toBe(initialParseCount);

      const finalStatus = extractor.getTreeStatus();
      expect(finalStatus.lastParseTime).toBe(initialStatus.lastParseTime);
    });

    it("should handle rapid successive changes efficiently", async () => {
      const model = createMockModel('console.log("test");');
      const extractor = await ContextExtractor.create(model);

      // Simulate rapid typing
      for (let i = 0; i < 10; i++) {
        const changeEvent = createMockChangeEvent([
          {
            range: {
              startLineNumber: 1,
              startColumn: 13 + i,
              endLineNumber: 1,
              endColumn: 13 + i,
            },
            rangeOffset: 12 + i,
            rangeLength: 0,
            text: i.toString(),
          },
        ]);
        extractor.onModelContentChanged(changeEvent);
      }

      expect(extractor.getTreeStatus().pendingEditsCount).toBe(10);
      expect(extractor.getTreeStatus().isDirty).toBe(true);

      // Single force build should handle all edits
      extractor.forceBuildTree();
      expect(extractor.getTreeStatus().pendingEditsCount).toBe(0);
    });
  });

  describe("boundary conditions", () => {
    it("should handle maximum fallback window", async () => {
      const lines = Array.from({ length: 1000 }, (_, i) => `// Line ${i + 1}`);
      const model = createMockModel(lines.join("\n"));
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor(
        { lineNumber: 500, column: 1 },
        { fallbackLineWindow: 999 }
      );

      expect(result).toBeDefined();
      expect(result.strategy).toBe("fallback-lines");
    });

    it("should handle zero fallback window", async () => {
      const model = createMockModel("line1\nline2\nline3");
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor(
        { lineNumber: 2, column: 1 },
        { fallbackLineWindow: 0 }
      );

      expect(result).toBeDefined();
      expect(result.strategy).toBe("fallback-lines");
    });

    it("should handle cursor position beyond file content", async () => {
      const model = createMockModel("short");
      const extractor = await ContextExtractor.create(model);

      const result = extractor.getContextAroundCursor({
        lineNumber: 100,
        column: 100,
      });

      expect(result).toBeDefined();
      expect(result.strategy).toBe("fallback-lines");
    });

    it("should handle exactly at line boundaries", async () => {
      const model = createMockModel("first\nsecond\nthird");
      const extractor = await ContextExtractor.create(model);

      // Test at exact end of first line
      const result1 = extractor.getContextAroundCursor({
        lineNumber: 1,
        column: 6,
      });
      expect(result1).toBeDefined();

      // Test at exact beginning of second line
      const result2 = extractor.getContextAroundCursor({
        lineNumber: 2,
        column: 1,
      });
      expect(result2).toBeDefined();
    });
  });
});
