#!/usr/bin/env node
// Human-readable summary of an eval run CSV.
//
// Prints:
//   - overall pass-rate (with Wilson 95% CI)
//   - per-category breakdown
//   - per-capability-axis breakdown (the diagnostic table — failures
//     here directly identify which agent component to fix)
//   - the list of failing cases with truncated reasons
//
// Usage:
//   npm run eval:summary               # uses the newest run-*.csv
//   npm run eval:summary -- <path>     # specific CSV

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPORTS_DIR = resolve(HERE, "..", "reports");

function pickPath() {
  const explicit = process.argv[2];
  if (explicit) return resolve(explicit);
  const files = readdirSync(REPORTS_DIR)
    .filter((f) => f.startsWith("run-") && f.endsWith(".csv"))
    .map((f) => ({ f, mtime: statSync(join(REPORTS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) {
    throw new Error(`no run-*.csv in ${REPORTS_DIR}`);
  }
  return join(REPORTS_DIR, files[0].f);
}

// Minimal CSV parser that respects "..." quoting + "" escapes.
function parseCsv(body) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQ = false;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (inQ) {
      if (c === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQ = false;
        }
      } else {
        cell += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") {
      cell += c;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.length > 0));
}

function wilson95(p, n) {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function pct(p) {
  return (p * 100).toFixed(1) + "%";
}

function groupCounts(rows, idx, statusIdx, keyFn = (v) => v) {
  const totals = new Map();
  const passes = new Map();
  for (const r of rows) {
    const key = keyFn(r[idx]);
    if (!key) continue;
    totals.set(key, (totals.get(key) ?? 0) + 1);
    if (r[statusIdx] === "pass") passes.set(key, (passes.get(key) ?? 0) + 1);
  }
  const out = [];
  for (const [key, total] of totals) {
    const pass = passes.get(key) ?? 0;
    out.push({ key, pass, total, rate: pass / total });
  }
  out.sort((a, b) => a.rate - b.rate || a.key.localeCompare(b.key));
  return out;
}

function bar(rate, width = 12) {
  const filled = Math.round(rate * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function pad(s, n) {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

const path = pickPath();
const body = readFileSync(path, "utf8");
const rows = parseCsv(body);
const header = rows[0];
const data = rows.slice(1);

const IDX = Object.fromEntries(header.map((h, i) => [h, i]));
const need = ["case_id", "category", "status", "duration_ms"];
for (const k of need) {
  if (IDX[k] === undefined) {
    throw new Error(`CSV header missing column "${k}". Found: ${header.join(",")}`);
  }
}
const HAS_AXIS = IDX.axis !== undefined;

const total = data.length;
const passed = data.filter((r) => r[IDX.status] === "pass").length;
const skipped = data.filter((r) => r[IDX.status] === "skip").length;
const failed = total - passed - skipped;
const [lo, hi] = wilson95(passed / Math.max(1, total - skipped), total - skipped);
const totalDurationMs = data.reduce((acc, r) => acc + Number(r[IDX.duration_ms] || 0), 0);

console.log(`\n=== ${basename(path)} ===`);
console.log(
  `OVERALL  ${passed}/${total} pass (${pct(passed / total)})` +
    (skipped > 0 ? `  [${skipped} skipped]` : "") +
    `   95% CI ${pct(lo)}-${pct(hi)}   wall ${(totalDurationMs / 1000).toFixed(1)}s\n`,
);

const byCategory = groupCounts(data, IDX.category, IDX.status);
console.log("BY CATEGORY");
for (const g of byCategory) {
  console.log(
    `  ${pad(g.key, 10)} ${pad(`${g.pass}/${g.total}`, 8)} ${pct(g.rate).padStart(6)}  ${bar(g.rate)}`,
  );
}

if (HAS_AXIS) {
  const byAxis = groupCounts(data, IDX.axis, IDX.status);
  if (byAxis.length > 0) {
    console.log("\nBY CAPABILITY AXIS (Bucket E diagnostics)");
    for (const g of byAxis) {
      console.log(
        `  ${pad(g.key, 24)} ${pad(`${g.pass}/${g.total}`, 8)} ${pct(g.rate).padStart(6)}  ${bar(g.rate)}`,
      );
    }
  }
} else {
  console.log("\n(this CSV predates the axis column; rerun eval to get diagnostics)");
}

const fails = data.filter((r) => r[IDX.status] === "fail");
if (fails.length > 0) {
  console.log("\nFAILING CASES");
  const failuresIdx = IDX.failures;
  for (const r of fails) {
    const axisLabel = HAS_AXIS && r[IDX.axis]
      ? `[axis=${r[IDX.axis]}]`
      : `[${r[IDX.category]}]`;
    const reason = (r[failuresIdx] ?? "").slice(0, 100);
    console.log(`  ✗ ${pad(r[IDX.case_id], 38)} ${pad(axisLabel, 30)} ${reason}`);
  }
}

const judgeRate = (() => {
  const haveJudge = data.filter((r) => Number(r[IDX.judge_count] ?? 0) > 0);
  if (haveJudge.length === 0) return null;
  const sumScore = haveJudge.reduce(
    (acc, r) => acc + Number(r[IDX.judge_avg_score] || 0),
    0,
  );
  return { count: haveJudge.length, avg: sumScore / haveJudge.length };
})();
if (judgeRate) {
  console.log(
    `\nJUDGE       ${judgeRate.count} cases   avg score ${judgeRate.avg.toFixed(2)}/5`,
  );
}
console.log();
