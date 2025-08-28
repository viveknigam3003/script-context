// Type definitions for web-tree-sitter
export interface SyntaxNode {
  id: number;
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  parent: SyntaxNode | null;
  namedChildCount: number;
  childCount: number;

  child(index: number): SyntaxNode | null;
  namedChild(index: number): SyntaxNode | null;
  childForFieldName(fieldName: string): SyntaxNode | null;
  descendantForIndex(index: number): SyntaxNode;
  descendantForIndex(startIndex: number, endIndex: number): SyntaxNode;
  descendantForPosition(position: { row: number; column: number }): SyntaxNode;
  descendantForPosition(
    startPosition: { row: number; column: number },
    endPosition: { row: number; column: number }
  ): SyntaxNode;
  namedDescendantForIndex(index: number): SyntaxNode;
  namedDescendantForIndex(startIndex: number, endIndex: number): SyntaxNode;
  namedDescendantForPosition(position: {
    row: number;
    column: number;
  }): SyntaxNode;
  namedDescendantForPosition(
    startPosition: { row: number; column: number },
    endPosition: { row: number; column: number }
  ): SyntaxNode;
  walk(): TreeCursor;
}

export interface TreeCursor {
  nodeType: string;
  nodeText: string;
  nodeId: number;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };

  reset(node: SyntaxNode): void;
  gotoParent(): boolean;
  gotoFirstChild(): boolean;
  gotoNextSibling(): boolean;
  gotoFirstChildForIndex(index: number): boolean;
  gotoDescendant(index: number): void;
}

export interface Tree {
  rootNode: SyntaxNode;
  copy(): Tree;
  edit(edit: Edit): void;
  getChangedRanges(other: Tree): Range[];
  getEditedRange(other: Tree): Range;
  walk(): TreeCursor;
}

export interface Edit {
  startIndex: number;
  oldEndIndex: number;
  newEndIndex: number;
  startPosition: { row: number; column: number };
  oldEndPosition: { row: number; column: number };
  newEndPosition: { row: number; column: number };
}

export interface Range {
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
}

export interface Language {
  version: number;
  nodeTypeCount: number;
  fieldCount: number;
}

export interface ParserClass {
  new (): ParserInstance;
  init(options?: {
    locateFile?: (scriptName: string, scriptDirectory: string) => string;
  }): Promise<void>;
  Language: {
    load(input: string | Uint8Array | ArrayBuffer): Promise<Language>;
  };
}

export interface ParserInstance {
  parse(
    input: string | Tree,
    previousTree?: Tree,
    options?: { bufferSize?: number; includedRanges?: Range[] }
  ): Tree;
  reset(): void;
  setLanguage(language: Language): void;
  getLanguage(): Language;
  setTimeoutMicros(timeout: number): void;
  getTimeoutMicros(): number;
  setLogger(
    logFunction: (message: string, params: { [param: string]: string }) => void
  ): void;
  getLogger():
    | ((message: string, params: { [param: string]: string }) => void)
    | null;
}

export interface ViteImportMeta {
  env: {
    BASE_URL?: string;
    [key: string]: string | boolean | undefined;
  };
}
