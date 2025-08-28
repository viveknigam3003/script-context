import * as TreeSitter from "web-tree-sitter";
import type { ViteImportMeta } from "./types";

let parserSingleton: TreeSitter.Parser | null = null;
let initialized = false;

// Defaults to Vite's base URL + /assets
let assetsBase = (import.meta as ViteImportMeta).env?.BASE_URL || "/";
assetsBase = assetsBase.endsWith("/") ? assetsBase.slice(0, -1) : assetsBase;
assetsBase = `${assetsBase}/assets`;

export function configureTreeSitter(opts: { assetsBaseUrl?: string } = {}) {
  if (opts.assetsBaseUrl) assetsBase = opts.assetsBaseUrl.replace(/\/$/, "");
  parserSingleton = null;
  initialized = false;
}

export async function ensureParser(): Promise<TreeSitter.Parser> {
  if (parserSingleton) return parserSingleton;

  if (!initialized) {
    await TreeSitter.Parser.init({
      // This tells web-tree-sitter where to load its runtime WASM (tree-sitter.wasm)
      locateFile: (filename: string) => `${assetsBase}/${filename}`,
    });
    initialized = true;
  }

  // Load the JS grammar WASM we copied to public/assets/
  const lang = await TreeSitter.Language.load(
    `${assetsBase}/tree-sitter-javascript.wasm`
  );
  const parser = new TreeSitter.Parser();
  parser.setLanguage(lang);
  parserSingleton = parser;
  return parser;
}
