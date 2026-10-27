// ATO-1025: one type scale. Below the token block, a font size of 20px or
// less is a --fs-* token, never a raw number (the review of 25.10 counted 30
// sizes, mostly half pixels). Headlines above 20px may stay as written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../renderer/", import.meta.url);
const files = ["styles.css", ...readdirSync(new URL("css/", dir)).filter((f) => f.endsWith(".css")).map((f) => "css/" + f)];

test("no raw font size of 20px or less outside the tokens", () => {
  const bad = [];
  for (const f of files) {
    let css = readFileSync(new URL(f, dir), "utf8");
    if (f === "styles.css") css = css.slice(css.indexOf("/* === end tokens === */"));
    const re = /font-size:\s*(\d+(?:\.\d+)?)px|font:\s*(?:italic\s+)?\d{3}\s+(\d+(?:\.\d+)?)px/g;
    let m;
    while ((m = re.exec(css))) if (Number(m[1] || m[2]) <= 20) bad.push(f + ": " + m[0]);
  }
  assert.deepEqual(bad, []);
});

test("the scale tokens exist", () => {
  const css = readFileSync(new URL("styles.css", dir), "utf8");
  for (const t of ["micro", "label", "cap", "ui", "body", "lead", "sub", "title"]) assert.match(css, new RegExp("--fs-" + t + ":\\d"));
});
