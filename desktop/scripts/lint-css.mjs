// ATO-2763: raw-colour gate for the desktop CSS (npm run lint:css).
//
// Runs stylelint with desktop/.stylelintrc.json over renderer/**/*.css:
// no hex colours, no named colours, no rgb()/rgba()/hsl()/hsla(); colours
// come from the tokens in renderer/styles.css, which the config exempts.
//
// The CSS already holds raw colours from before the gate. They are
// grandfathered by count, not by line: scripts/stylelint-baseline.json maps
// each file to how many times it uses each literal ("color-no-hex #fff": 3).
// A file fails when it uses a literal more often than its baseline allows,
// so a NEW raw colour fails in every file, legacy ones included, while edits
// that only move old lines around (wave 11 is restyling these screens) pass.
// Cleaning up the legacy colours is ATO-2779.
//
//   node scripts/lint-css.mjs                    check
//   node scripts/lint-css.mjs --update-baseline  rewrite the baseline from the
//       current CSS. Only for shrinking it after a cleanup: a baseline that
//       grows in a PR needs the reviewer's explicit ok.
import stylelint from "stylelint";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(desktop, "scripts", "stylelint-baseline.json");
const update = process.argv.includes("--update-baseline");

const { results } = await stylelint.lint({
  cwd: desktop,
  files: "renderer/**/*.css",
  configFile: join(desktop, ".stylelintrc.json"),
});

const problems = [];
const counts = {};
const hits = {};
for (const r of results) {
  const file = relative(desktop, r.source).split(sep).join("/");
  for (const w of r.invalidOptionWarnings ?? []) problems.push(`${file}: invalid option: ${w.text}`);
  for (const w of r.parseErrors ?? []) problems.push(`${file}:${w.line}:${w.column} parse error: ${w.text}`);
  for (const w of r.warnings) {
    const literal = (w.text.match(/"([^"]+)"/) ?? [, ""])[1].toLowerCase();
    const key = `${w.rule} ${literal}`.trim();
    counts[file] ??= {};
    counts[file][key] = (counts[file][key] ?? 0) + 1;
    (hits[file + "\n" + key] ??= []).push(`${file}:${w.line}:${w.column} ${w.text}`);
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

if (update) {
  const sorted = {};
  for (const f of Object.keys(counts).sort()) {
    sorted[f] = Object.fromEntries(Object.entries(counts[f]).sort(([a], [b]) => a.localeCompare(b)));
  }
  writeFileSync(baselinePath, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`lint:css: baseline rewritten (${Object.keys(sorted).length} files)`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const fresh = [];
const shrinkable = [];
for (const [file, keys] of Object.entries(counts)) {
  for (const [key, n] of Object.entries(keys)) {
    const allowed = baseline[file]?.[key] ?? 0;
    if (n > allowed) {
      fresh.push(`${n - allowed} new: ${key}. Use a token from renderer/styles.css.`);
      fresh.push(...hits[file + "\n" + key].map((h) => "  " + h));
    }
  }
}
for (const [file, keys] of Object.entries(baseline)) {
  for (const [key, allowed] of Object.entries(keys)) {
    if ((counts[file]?.[key] ?? 0) < allowed) shrinkable.push(`${file}: ${key}`);
  }
}

if (shrinkable.length) {
  console.log("lint:css: fewer raw colours than the baseline allows (run with --update-baseline to lock that in):");
  console.log(shrinkable.map((s) => "  " + s).join("\n"));
}
if (fresh.length) {
  console.error("lint:css: new raw colours in the desktop CSS:\n" + fresh.join("\n"));
  process.exit(1);
}
console.log("lint:css: no new raw colours");
