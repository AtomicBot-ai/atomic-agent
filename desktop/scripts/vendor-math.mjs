/* ATO-1140: formulas (KaTeX) and diagrams (Mermaid) in chat replies.
   The two libraries are npm dependencies, not files kept in git: this step
   copies their browser builds from node_modules into out/renderer/vendor/
   after copy-renderer.mjs, so the window can load them from its own files
   (script-src 'self', font-src 'self') the first time a reply needs them
   (renderer/rich-blocks.js). Nothing is fetched from the network.

   Copied:
     katex/dist/katex.min.js, katex.min.css, fonts/*.woff2  -> vendor/katex/
     mermaid/dist/mermaid.min.js                             -> vendor/mermaid/
     each package's LICENSE beside its files.
   Only the .woff2 fonts are copied: katex.min.css lists woff2 first, and
   Chromium never asks for the .woff / .ttf fallbacks. */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "package.json"));
const out = join(here, "..", "out", "renderer", "vendor");

function pkgDir(name) {
  return dirname(require.resolve(`${name}/package.json`));
}

function copy(from, to) {
  if (!existsSync(from)) throw new Error(`vendor-math: missing ${from} (run npm ci in desktop/)`);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

const katex = pkgDir("katex");
const kOut = join(out, "katex");
copy(join(katex, "dist", "katex.min.js"), join(kOut, "katex.min.js"));
copy(join(katex, "dist", "katex.min.css"), join(kOut, "katex.min.css"));
copy(join(katex, "LICENSE"), join(kOut, "LICENSE.txt"));
const fonts = join(katex, "dist", "fonts");
let n = 0;
for (const f of readdirSync(fonts)) {
  if (!f.endsWith(".woff2")) continue;
  copy(join(fonts, f), join(kOut, "fonts", f));
  n++;
}

const mermaid = pkgDir("mermaid");
const mOut = join(out, "mermaid");
copy(join(mermaid, "dist", "mermaid.min.js"), join(mOut, "mermaid.min.js"));
copy(join(mermaid, "LICENSE"), join(mOut, "LICENSE.txt"));

console.log(`katex (${n} fonts) + mermaid → ${out}`);
