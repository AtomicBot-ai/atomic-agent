#!/usr/bin/env node
// Summary + pre-release gate for the small-model bench (ATO-1118).
//
//   node eval-agents/small-models/summary.mjs <results.jsonl> [more.jsonl …] [--out summary.md]
//   node eval-agents/small-models/summary.mjs <results.jsonl …> --gate [--thresholds thresholds.json]
//
// Several files can be merged (e.g. one per machine). The last row for the same
// (model, window, thinking, task, repeat) wins, so a rerun replaces the old try.
// Exit codes with --gate: 0 = gate passed, 1 = a cell is below its threshold,
// 3 = not enough data (missing cell or too few repeats), 2 = usage error.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { clip, median } from "./lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function parseJsonl(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r && typeof r === "object" && typeof r.task === "string");
}

/** Last row per (model, window, thinking, task, repeat) wins. */
export function dedupe(rows) {
  const m = new Map();
  for (const r of rows) m.set([r.model, r.window, r.thinking, r.task, r.repeat].join("|"), r);
  return [...m.values()];
}

const cellKey = (r) => `${r.model}|${r.window}|${r.thinking}`;
const pct = (k, n) => (n ? `${Math.round((100 * k) / n)}%` : "–");
const tokens = (r) => (r.promptTokens ?? 0) + (r.predictedTokens ?? 0);

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

function sortRows(a, b) {
  return (
    String(a.size).localeCompare(String(b.size), undefined, { numeric: true }) ||
    String(a.model).localeCompare(String(b.model)) ||
    a.window - b.window ||
    String(a.thinking).localeCompare(String(b.thinking))
  );
}

export function renderMarkdown(rowsIn) {
  const rows = dedupe(rowsIn).sort(sortRows);
  const out = [];
  out.push("## Small-model bench", "");
  out.push("| model | window | thinking | core | stress | median s | median tokens | compactions |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const [, g] of groupBy(rows, cellKey)) {
    const r0 = g[0];
    const core = g.filter((r) => r.set === "core");
    const stress = g.filter((r) => r.set === "stress");
    const cp = (s) => `${s.filter((r) => r.pass).length}/${s.length} (${pct(s.filter((r) => r.pass).length, s.length)})`;
    out.push(
      `| ${r0.model} | ${r0.window} | ${r0.thinking} | ${core.length ? cp(core) : "–"} | ${stress.length ? cp(stress) : "–"} | ` +
        `${median(g.map((r) => r.seconds)) ?? "–"} | ${median(g.map(tokens)) ?? "–"} | ${g.reduce((s, r) => s + (r.compactions ?? 0), 0)} |`,
    );
  }
  out.push("", "### Per task", "");
  out.push("| model | window | thinking | task | passed | rate | median s | median tokens | steps | compactions | why it failed (most common) |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [, g] of groupBy(rows, (r) => `${cellKey(r)}|${r.task}`)) {
    const r0 = g[0];
    const k = g.filter((r) => r.pass).length;
    const reasons = groupBy(g.filter((r) => !r.pass), (r) => clip(r.reason, 50));
    const top = [...reasons.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    out.push(
      `| ${r0.model} | ${r0.window} | ${r0.thinking} | ${r0.task} | ${k}/${g.length} | ${pct(k, g.length)} | ` +
        `${median(g.map((r) => r.seconds)) ?? "–"} | ${median(g.map(tokens)) ?? "–"} | ${median(g.map((r) => r.steps)) ?? "–"} | ` +
        `${g.reduce((s, r) => s + (r.compactions ?? 0), 0)} | ${top ? `${top[0]} (×${top[1].length})` : ""} |`,
    );
  }
  return `${out.join("\n")}\n`;
}

/**
 * Gate: every cell of a gated size (and every required cell) must reach the
 * size's minimum pass rate on the gated set, with >= minRepeats runs per task.
 */
export function gate(rowsIn, thresholds) {
  const rows = dedupe(rowsIn).filter((r) => r.set === (thresholds.gatedSet ?? "core"));
  const bySize = thresholds.minPassRate ?? {};
  const cells = [];
  const seen = new Set();
  const groups = groupBy(rows, (r) => `${r.size}|${r.window}|${r.thinking}|${r.model}`);
  for (const [, g] of groups) {
    const r0 = g[0];
    const need = bySize[r0.size];
    if (need === undefined) continue;
    seen.add(`${r0.size}|${r0.window}|${r0.thinking}`);
    const perTask = groupBy(g, (r) => r.task);
    const thin = [...perTask.entries()].filter(([, v]) => v.length < (thresholds.minRepeats ?? 1)).map(([t]) => t);
    const k = g.filter((r) => r.pass).length;
    const rate = k / g.length;
    let status = rate >= need ? "pass" : "fail";
    let why = rate >= need ? "" : `${Math.round(rate * 100)}% < ${Math.round(need * 100)}%`;
    if (thin.length && status === "pass") {
      status = "missing";
      why = `fewer than ${thresholds.minRepeats} runs: ${thin.join(", ")}`;
    }
    cells.push({ model: r0.model, size: r0.size, window: r0.window, thinking: r0.thinking, passed: k, runs: g.length, rate, need, status, why });
  }
  for (const req of thresholds.requireCells ?? []) {
    if (!seen.has(`${req.size}|${req.window}|${req.thinking}`)) {
      cells.push({ model: "–", size: req.size, window: req.window, thinking: req.thinking, passed: 0, runs: 0, rate: 0, need: bySize[req.size] ?? null, status: "missing", why: "no results for this cell" });
    }
  }
  const anyFail = cells.some((c) => c.status === "fail");
  const anyMissing = cells.some((c) => c.status === "missing") || cells.length === 0;
  return { ok: !anyFail && !anyMissing, exitCode: anyFail ? 1 : anyMissing ? 3 : 0, cells };
}

export function renderGate(result) {
  const out = ["", "### Pre-release gate", "", "| size | model | window | thinking | core passed | rate | needed | verdict |", "|---|---|---|---|---|---|---|---|"];
  for (const c of result.cells) {
    out.push(
      `| ${c.size} | ${c.model} | ${c.window} | ${c.thinking} | ${c.passed}/${c.runs} | ${c.runs ? `${Math.round(c.rate * 100)}%` : "–"} | ` +
        `${c.need === null ? "–" : `${Math.round(c.need * 100)}%`} | ${c.status.toUpperCase()}${c.why ? `: ${c.why}` : ""} |`,
    );
  }
  out.push("", `Gate: ${result.ok ? "PASSED" : result.exitCode === 1 ? "FAILED" : "NOT ENOUGH DATA"}`);
  return `${out.join("\n")}\n`;
}

function main(argv) {
  const files = [];
  let doGate = false;
  let thresholdsPath = join(HERE, "thresholds.json");
  let outPath = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--gate") doGate = true;
    else if (a === "--thresholds") thresholdsPath = argv[(i += 1)];
    else if (a === "--out") outPath = argv[(i += 1)];
    else files.push(a);
  }
  if (!files.length) {
    process.stderr.write("usage: summary.mjs <results.jsonl …> [--gate] [--thresholds file] [--out file.md]\n");
    return 2;
  }
  const rows = [];
  for (const f of files) {
    if (!existsSync(f)) {
      process.stderr.write(`no such file: ${f}\n`);
      return 2;
    }
    rows.push(...parseJsonl(readFileSync(f, "utf8")));
  }
  let md = renderMarkdown(rows);
  let code = 0;
  if (doGate) {
    const result = gate(rows, JSON.parse(readFileSync(thresholdsPath, "utf8")));
    md += renderGate(result);
    code = result.exitCode;
  }
  process.stdout.write(md);
  if (outPath) writeFileSync(resolve(outPath), md);
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
