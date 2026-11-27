// ATO-2763: every text-on-background token pair the desktop draws keeps WCAG
// AA in the light theme and in both ways of getting the dark one (the OS
// setting and data-theme="dark"): 4.5:1 for text, 3:1 for large text and UI.
// The pairs live in contrast-pairs.json; the token parsing in css-tokens.mjs.
// A pair that already failed when the gate landed is listed there under
// knownFailures with its Linear bug, so the gate starts green and still
// catches a new regression or a known one getting worse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { themes, pairRatio, parseColor, contrast, over } from "./css-tokens.mjs";

const data = JSON.parse(readFileSync(new URL("./contrast-pairs.json", import.meta.url), "utf8"));
const MIN = { text: 4.5, ui: 3 };
const all = themes();

const label = (p, theme, ground) =>
  `${p.fg} on ${p.bg}${ground ? " over " + ground : ""} (${theme})`;
const known = (p, theme, ground) =>
  data.knownFailures.find((k) => k.fg === p.fg && k.bg === p.bg && k.theme === theme && (k.ground ?? null) === (ground ?? null));

// Each measured case: one pair, one theme, one ground.
function cases() {
  const out = [];
  for (const p of data.pairs) {
    for (const [theme, map] of Object.entries(all)) {
      for (const ground of p.ground ?? [undefined]) {
        out.push({ p, theme, ground, ratio: pairRatio(map, { fg: p.fg, bg: p.bg, ground }) });
      }
    }
  }
  return out;
}

test("the contrast maths matches known WCAG values", () => {
  assert.equal(contrast(parseColor("#000"), parseColor("#FFFFFF")).toFixed(2), "21.00");
  assert.equal(contrast(parseColor("#767676"), parseColor("#fff")).toFixed(2), "4.54");
  assert.deepEqual(over(parseColor("rgba(0,0,0,.5)"), parseColor("#ffffff")), [127.5, 127.5, 127.5, 1]);
  const mix = parseColor("color-mix(in srgb, #FF0000 25%, transparent)");
  assert.deepEqual(mix, [255, 0, 0, 0.25]);
});

test("all three themes resolve and the dark ones really differ from light", () => {
  for (const [theme, map] of Object.entries(all)) {
    for (const t of ["--paper", "--ink", "--accent", "--well", "--lift"]) {
      assert.doesNotThrow(() => pairRatio(map, { fg: t, bg: "--paper" }), `${t} resolves in ${theme}`);
    }
  }
  const ink = (theme) => pairRatio(all[theme], { fg: "--ink", bg: "--on-strong" });
  assert.notEqual(ink("light").toFixed(2), ink("dark-os").toFixed(2), "dark-os re-points --ink");
  assert.notEqual(ink("light").toFixed(2), ink("dark-forced").toFixed(2), "dark-forced re-points --ink");
});

test("every pair names a known kind and real tokens", () => {
  for (const p of data.pairs) assert.ok(MIN[p.kind], `${p.fg} on ${p.bg}: kind "${p.kind}"`);
  for (const k of data.knownFailures) {
    assert.ok(data.pairs.some((p) => p.fg === k.fg && p.bg === k.bg), `known failure ${k.fg} on ${k.bg} is a listed pair`);
    assert.match(k.issue, /^ATO-\d+$/);
  }
});

test("text and UI token pairs keep WCAG AA contrast", () => {
  const bad = [];
  for (const { p, theme, ground, ratio } of cases()) {
    if (ratio >= MIN[p.kind] || known(p, theme, ground)) continue;
    bad.push(`${label(p, theme, ground)} is ${ratio.toFixed(2)}:1, needs ${MIN[p.kind]}:1 (${p.where})`);
  }
  assert.deepEqual(bad, []);
});

test("known failures do not get worse, and leave the list once fixed", () => {
  const bad = [];
  for (const { p, theme, ground, ratio } of cases()) {
    const k = known(p, theme, ground);
    if (!k) continue;
    if (ratio >= MIN[p.kind]) bad.push(`${label(p, theme, ground)} now passes at ${ratio.toFixed(2)}:1: delete it from knownFailures (${k.issue})`);
    else if (ratio < k.ratio - 0.01) bad.push(`${label(p, theme, ground)} dropped to ${ratio.toFixed(2)}:1 from ${k.ratio}:1 (${k.issue})`);
  }
  const measured = cases();
  const unmatched = data.knownFailures.filter((k) => !measured.some((c) => known(c.p, c.theme, c.ground) === k));
  for (const k of unmatched) bad.push(`knownFailures entry ${k.fg} on ${k.bg} (${k.theme}) matches no measured case`);
  assert.deepEqual(bad, []);
});
