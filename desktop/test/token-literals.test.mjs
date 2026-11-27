// ATO-2763: styles.css is the token file, so stylelint's raw-colour rules are
// switched off for it (desktop/.stylelintrc.json). Its own header promises
// that colour literals live above the end-of-tokens marker only; this pins
// the part below the marker, which the stylelint override no longer covers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../renderer/styles.css", import.meta.url), "utf8");
const MARKER = "/* === end tokens === */";

test("styles.css has no raw colour below the end-of-tokens marker", () => {
  assert.ok(css.includes(MARKER), "styles.css keeps its end-of-tokens marker");
  const below = css.slice(css.indexOf(MARKER)).replace(/\/\*[\s\S]*?\*\//g, "");
  // A declaration value (after ':' and before ';', '{' or '}') holding a hex
  // colour, rgb()/rgba()/hsl()/hsla(), or a common colour name.
  const re = /:[^;{}]*?(#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(|(?<![\w-])(?:white|black|red|green|blue|gray|grey|yellow|orange|purple|pink)(?![\w-]))/gi;
  const found = [...below.matchAll(re)].map((m) => m[0].trim().slice(0, 80));
  assert.deepEqual(found, [], "use a token from the top of styles.css instead");
});
