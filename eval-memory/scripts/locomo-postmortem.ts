#!/usr/bin/env tsx
/**
 * Postmortem CLI for LoCoMo run traces.
 *
 * Usage:
 *   tsx eval-memory/scripts/locomo-postmortem.ts <trace.ndjson|stateDir|reportDir>
 *
 * Argument resolution:
 *   - When a regular file ending in `.ndjson` is passed, that single
 *     trace is analyzed.
 *   - When a directory is passed, the script looks for one of:
 *       * `<arg>/traces/*.ndjson` (typical `keptStateDir` shape)
 *       * `<arg>/run-diagnostics.txt` plus a `keptTracePath` line
 *         (typical report dir shape — the script follows the path)
 *     and analyzes the most recent trace file.
 *
 * Output: markdown report on stdout. Pipe through `tee` to keep a copy.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";

import {
  analyzeTrace,
  parseTraceNdjson,
  renderPostmortem,
} from "../harness/postmortem-trace.js";

function resolveTracePath(input: string): string {
  const abs = resolve(input);
  const st = statSync(abs);
  if (st.isFile() && abs.endsWith(".ndjson")) return abs;
  if (st.isDirectory()) {
    // Try <dir>/traces/*.ndjson first (keptStateDir layout).
    const tracesDir = resolve(abs, "traces");
    try {
      const list = readdirSync(tracesDir).filter((f) => f.endsWith(".ndjson"));
      if (list.length === 1) return resolve(tracesDir, list[0]);
      if (list.length > 1) {
        // Pick the largest (longest run) — heuristic for the canonical session.
        const sorted = list
          .map((f) => ({ f, size: statSync(resolve(tracesDir, f)).size }))
          .sort((a, b) => b.size - a.size);
        process.stderr.write(
          `[postmortem] multiple traces under ${tracesDir}; picking largest: ${sorted[0].f} (${sorted[0].size} bytes)\n`,
        );
        return resolve(tracesDir, sorted[0].f);
      }
    } catch {
      /* fall through */
    }
    // Try report-dir layout: read run-diagnostics.txt and follow first
    // keptTracePath line.
    try {
      const diag = readFileSync(resolve(abs, "run-diagnostics.txt"), "utf8");
      const m = diag.match(/^keptTracePath:\s+(.+)$/m);
      if (m && m[1] !== "-") return resolve(m[1].trim());
    } catch {
      /* fall through */
    }
  }
  throw new Error(
    `Cannot locate a trace ndjson under ${abs}. Expected a *.ndjson file, a <stateDir> with traces/*.ndjson, or a report dir with run-diagnostics.txt + keptTracePath.`,
  );
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 0) {
    process.stderr.write(
      "usage: tsx eval-memory/scripts/locomo-postmortem.ts <trace.ndjson|stateDir|reportDir>\n",
    );
    return 2;
  }
  const path = resolveTracePath(argv[0]);
  process.stderr.write(`[postmortem] analyzing: ${path}\n`);
  const raw = readFileSync(path, "utf8");
  let skipped = 0;
  const events = parseTraceNdjson(raw, () => (skipped += 1));
  if (skipped > 0) {
    process.stderr.write(
      `[postmortem] skipped ${skipped} malformed line(s) — file may have been truncated mid-write\n`,
    );
  }
  const report = analyzeTrace(events);
  process.stdout.write(`\n<!-- source: ${basename(path)} -->\n`);
  process.stdout.write(renderPostmortem(report));
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[postmortem] ${(err as Error).message}\n`);
    process.exit(1);
  });
