#!/usr/bin/env node
/**
 * Summarise the latest eval-agents CSV matrix into per-agent accuracy.
 *
 * Usage:
 *   npm run eval:agents:scorecard
 *   node eval-agents/scripts/scorecard.mjs --run eval-agents/reports/run-...
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPORTS = resolve(HERE, "..", "reports");

function parseArgs(argv) {
  const out = { run: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--run") out.run = argv[++i] ?? null;
  }
  return out;
}

function latestRunDir() {
  if (!existsSync(REPORTS)) return null;
  const dirs = readdirSync(REPORTS)
    .filter((name) => name.startsWith("run-"))
    .map((name) => join(REPORTS, name))
    .filter((p) => statSync(p).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0] ?? null;
}

function parseCsv(path) {
  const text = readFileSync(path, "utf8").trim();
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    const row = {};
    header.forEach((key, i) => {
      row[key] = cols[i] ?? "";
    });
    return row;
  });
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = args.run ? resolve(args.run) : latestRunDir();
  if (!runDir) {
    console.error("no reports found under eval-agents/reports/");
    process.exit(2);
  }
  const csvPath = join(runDir, "matrix.csv");
  if (!existsSync(csvPath)) {
    console.error(`missing ${csvPath}`);
    process.exit(2);
  }

  const rows = parseCsv(csvPath);
  const byAgent = new Map();

  function emptyAgg() {
    return { total: 0, correct: 0, skipped: 0, ms: 0, byLevel: new Map() };
  }

  for (const row of rows) {
    const id = row.agent_id;
    if (!byAgent.has(id)) byAgent.set(id, emptyAgg());
    const agg = byAgent.get(id);
    if (row.skipped === "1") {
      agg.skipped += 1;
      continue;
    }
    const level = row.level || "?";
    if (!agg.byLevel.has(level)) agg.byLevel.set(level, { total: 0, correct: 0 });
    const lvl = agg.byLevel.get(level);

    agg.total += 1;
    lvl.total += 1;
    if (row.correct === "1") {
      agg.correct += 1;
      lvl.correct += 1;
    }
    agg.ms += Number(row.wall_clock_ms || 0);
  }

  const pct = (c, t) => (t > 0 ? `${((c / t) * 100).toFixed(1)}%` : "n/a");

  console.log(`Scorecard: ${runDir}\n`);
  console.log("agent_id\taccuracy\tcorrect/total\tskipped\tavg_wall_ms");
  for (const [id, agg] of [...byAgent.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const avgMs = agg.total > 0 ? Math.round(agg.ms / agg.total) : 0;
    console.log(
      `${id}\t${pct(agg.correct, agg.total)}\t${agg.correct}/${agg.total}\t${agg.skipped}\t${avgMs}`,
    );
  }

  // Per-level breakdown (GAIA L1/L2/L3) — required by the plan scorecard.
  const levels = [...new Set(rows.map((r) => r.level).filter(Boolean))].sort();
  if (levels.length > 0) {
    console.log(`\nPer-level accuracy:`);
    console.log(`agent_id\t${levels.map((l) => `L${l}`).join("\t")}`);
    for (const [id, agg] of [...byAgent.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const cells = levels.map((l) => {
        const lvl = agg.byLevel.get(l);
        return lvl ? pct(lvl.correct, lvl.total) : "n/a";
      });
      console.log(`${id}\t${cells.join("\t")}`);
    }
  }
}

main();
