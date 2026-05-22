#!/usr/bin/env node
/**
 * Atomic-eval aggregator (PLAN.md Phase 4).
 *
 * Walks `eval-memory/reports/run-*` directories, pulls every
 * `summary.md` it finds, and writes a single roll-up markdown that
 * lists every experiment, its run timestamp, and (when present) the
 * decision-boundary metric called out at the top of the per-run
 * summary.
 *
 * The aggregator is deliberately format-agnostic — it embeds the
 * head + the first metrics table from each `summary.md` so a quick
 * "where do we stand" view never lies about how each experiment
 * actually scored. Operators who need the full report still click
 * through to the per-run directory; the aggregator is the cheat
 * sheet.
 *
 * Usage:
 *
 *   node eval-memory/scripts/aggregate-atomic-eval.mjs [--out <path>] \
 *        [--reports <reports-dir>] [--match <regex>]
 *
 *   --out      output path (default: eval-memory/reports/atomic-eval-rollup.md)
 *   --reports  reports root (default: eval-memory/reports)
 *   --match    only include run directories whose name matches the regex
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const DEFAULT_REPORTS = resolve(REPO_ROOT, "eval-memory", "reports");
const DEFAULT_OUT = resolve(REPO_ROOT, "eval-memory", "reports", "atomic-eval-rollup.md");

const args = parseArgs(process.argv.slice(2));
const reportsDir = resolve(args.reports ?? DEFAULT_REPORTS);
const outPath = resolve(args.out ?? DEFAULT_OUT);
const matchRe = args.match ? new RegExp(args.match) : null;

if (!existsSync(reportsDir)) {
  process.stderr.write(`[aggregate-atomic-eval] reports dir missing: ${reportsDir}\n`);
  process.exit(2);
}

const runs = readdirSync(reportsDir)
  .filter((d) => d.startsWith("run-"))
  .filter((d) => !matchRe || matchRe.test(d))
  .filter((d) => statSync(resolve(reportsDir, d)).isDirectory())
  .sort();

const sections = [];
for (const runDir of runs) {
  const summaryPath = resolve(reportsDir, runDir, "summary.md");
  if (!existsSync(summaryPath)) continue;
  const summary = readFileSync(summaryPath, "utf8");
  sections.push({ runDir, summary });
}

const lines = [
  "# Atomic memory-eval rollup",
  "",
  `_Generated_: ${new Date().toISOString()}`,
  `_Reports root_: \`${reportsDir}\``,
  `_Runs aggregated_: ${sections.length}`,
  "",
];

if (sections.length === 0) {
  lines.push("> No `summary.md` files found under any `run-*` directory.");
  lines.push("> Run an experiment first (e.g. `npm run eval:memory:e1`).");
} else {
  for (const { runDir, summary } of sections) {
    lines.push(`## \`${runDir}\``);
    lines.push("");
    lines.push("```markdown");
    lines.push(extractHeadAndFirstTable(summary));
    lines.push("```");
    lines.push("");
    lines.push(
      `_Full report_: \`${resolve(reportsDir, runDir)}\``,
    );
    lines.push("");
  }
}

writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
process.stderr.write(`[aggregate-atomic-eval] wrote ${outPath} (${sections.length} runs)\n`);

/**
 * Pull the first heading + the first markdown table out of the
 * summary so the rollup stays compact. When no table is present, the
 * first ~12 lines are returned.
 */
function extractHeadAndFirstTable(text) {
  const lines = text.split(/\r?\n/);
  const head = [];
  let headTaken = false;
  let inTable = false;
  let tableLines = 0;
  for (const line of lines) {
    if (!headTaken) {
      head.push(line);
      if (line.trim().startsWith("|")) {
        headTaken = true;
        inTable = true;
        tableLines = 1;
        continue;
      }
      if (head.length >= 12) {
        headTaken = true;
      }
      continue;
    }
    if (inTable) {
      if (line.trim().startsWith("|")) {
        head.push(line);
        tableLines += 1;
        if (tableLines >= 20) break;
      } else {
        break;
      }
    }
  }
  return head.join("\n").trim();
}

function parseArgs(argv) {
  const out = { out: null, reports: null, match: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    else if (a === "--reports") out.reports = argv[++i];
    else if (a === "--match") out.match = argv[++i];
    else if (a === "-h" || a === "--help") {
      process.stdout.write(
        "Usage: node eval-memory/scripts/aggregate-atomic-eval.mjs " +
          "[--out <path>] [--reports <dir>] [--match <regex>]\n",
      );
      process.exit(0);
    } else {
      process.stderr.write(`[aggregate-atomic-eval] unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

// Eliminate unused warning for the imported basename helper — kept
// around because future per-experiment slug parsing will need it.
void basename;
