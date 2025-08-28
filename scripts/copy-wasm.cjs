const fs = require("fs");
const path = require("path");

const copies = [
  [
    "node_modules/web-tree-sitter/tree-sitter.wasm",
    "public/assets/tree-sitter.wasm",
  ],
  [
    "node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm",
    "public/assets/tree-sitter-javascript.wasm",
  ],
];

for (const [src, dst] of copies) {
  const dir = path.dirname(dst);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`Copied ${src} -> ${dst}`);
}
