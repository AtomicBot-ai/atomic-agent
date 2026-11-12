/**
 * ATO-818: the end of a terminal import, said as a moment rather than a
 * count. After the itemised "Result:" list, one line per kind appears with a
 * check mark, one after another, then a single sentence of what is now here:
 *
 *   ✓ sessions   44 imported
 *   ✓ memory      6 imported
 *   ✓ skills      9 imported
 *
 *   44 chats and 6 memories are now in Atomic Agent.
 *
 * The desktop shows the same moment with particles (renderer import_done).
 * Here it is only the pacing: on a terminal the rows come in one by one, and
 * anywhere else (a pipe, a log, CI, `--json`) everything is printed at once,
 * with no delay and no escape codes.
 */
import type { ImportReport } from "../import/index.js";

export interface FinaleRow {
  kind: string;
  imported: number;
  skipped: number;
  conflict: number;
  failed: number;
}

/** Per-kind counts, in the order the kinds first appear in the report. */
export function finaleRows(report: ImportReport): FinaleRow[] {
  const rows: FinaleRow[] = [];
  const byKind = new Map<string, FinaleRow>();
  for (const item of report.items) {
    let row = byKind.get(item.kind);
    if (!row) {
      row = { kind: item.kind, imported: 0, skipped: 0, conflict: 0, failed: 0 };
      byKind.set(item.kind, row);
      rows.push(row);
    }
    if (item.status === "migrated") row.imported += 1;
    else if (item.status === "skipped") row.skipped += 1;
    else if (item.status === "conflict") row.conflict += 1;
    else row.failed += 1;
  }
  return rows;
}

/** One row as printed: a mark, the kind, and its counts in words. */
export function finaleRowText(row: FinaleRow, kindWidth: number, countWidth: number): string {
  const mark = row.failed > 0 ? "!" : row.imported > 0 ? "✓" : "·";
  const parts = [`${String(row.imported).padStart(countWidth)} imported`];
  if (row.skipped > 0) parts.push(`${row.skipped} skipped`);
  if (row.conflict > 0) parts.push(`${row.conflict} in conflict`);
  if (row.failed > 0) parts.push(`${row.failed} failed`);
  return `  ${mark} ${row.kind.padEnd(kindWidth)}  ${parts.join(", ")}`;
}

/* The words a person uses for the two kinds that matter most. */
const PLAIN_KIND: Record<string, [string, string]> = {
  sessions: ["chat", "chats"],
  session: ["chat", "chats"],
  memory: ["memory", "memories"],
  memories: ["memory", "memories"],
};

/**
 * The closing sentence: chats and memories by name when there are any,
 * otherwise everything that was imported, or null when nothing was.
 */
export function finaleSentence(rows: FinaleRow[]): string | null {
  const total = rows.reduce((n, r) => n + r.imported, 0);
  if (total === 0) return null;
  const named: Array<{ n: number; text: string }> = [];
  for (const row of rows) {
    const words = PLAIN_KIND[row.kind];
    if (!words || row.imported === 0) continue;
    named.push({ n: row.imported, text: `${row.imported} ${row.imported === 1 ? words[0] : words[1]}` });
  }
  const what = named.length > 0
    ? named.map((x) => x.text).join(" and ")
    : `${total} ${total === 1 ? "item" : "items"}`;
  const one = named.length > 0 ? named.length === 1 && named[0]!.n === 1 : total === 1;
  return `${what} ${one ? "is" : "are"} now in Atomic Agent.`;
}

/** Everything the finale prints, in order (empty when nothing ran). */
export function finaleLines(report: ImportReport): string[] {
  if (!report.executed) return [];
  const rows = finaleRows(report);
  if (rows.length === 0) return [];
  const kindWidth = Math.max(...rows.map((r) => r.kind.length));
  const countWidth = Math.max(...rows.map((r) => String(r.imported).length));
  const lines = rows.map((r) => finaleRowText(r, kindWidth, countWidth));
  const sentence = finaleSentence(rows);
  if (sentence) lines.push("", `  ${sentence}`);
  return lines;
}

export interface FinaleIo {
  write: (text: string) => void;
  /** Whether stdout is an interactive terminal. */
  isTTY: boolean;
  /** `--json` was asked for: the finale stays out of a JSON stream. */
  json?: boolean;
  /** Pause between rows on a terminal (ms). */
  stepMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Print the finale. On a terminal the rows appear one by one; anywhere else
 * they are written at once. Nothing at all under `--json`.
 */
export async function writeImportFinale(report: ImportReport, io: FinaleIo): Promise<void> {
  if (io.json) return;
  const lines = finaleLines(report);
  if (lines.length === 0) return;
  if (!io.isTTY) {
    io.write(`\n${lines.join("\n")}\n`);
    return;
  }
  const sleep = io.sleep ?? defaultSleep;
  const step = io.stepMs ?? 140;
  io.write("\n");
  for (const line of lines) {
    if (line !== "") await sleep(step);
    io.write(`${line}\n`);
  }
}

/** The process's own stdout, as the import commands use it. */
export function processFinaleIo(args: string[]): FinaleIo {
  return {
    write: (t) => process.stdout.write(t),
    isTTY: !!process.stdout.isTTY && !process.env.CI,
    json: args.includes("--json"),
  };
}
