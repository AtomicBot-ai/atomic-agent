import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const REPORTS_ROOT = resolve(REPO_ROOT, "eval-memory", "reports");

/**
 * Per-run report directory. One directory per `npm run eval:memory*`
 * invocation, named after the start timestamp so consecutive runs do
 * not clobber each other.
 */
export interface ReportRun {
  /** Absolute path to the run directory. */
  dir: string;
  /** ISO timestamp the run started. */
  startedAt: string;
}

export function startReportRun(opts?: { label?: string }): ReportRun {
  if (!existsSync(REPORTS_ROOT)) mkdirSync(REPORTS_ROOT, { recursive: true });
  const startedAt = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = opts?.label
    ? `${startedAt}-${opts.label.replace(/[^a-zA-Z0-9_-]+/g, "-")}`
    : startedAt;
  const dir = resolve(REPORTS_ROOT, `run-${slug}`);
  mkdirSync(dir, { recursive: true });
  return { dir, startedAt };
}

/** Resolve a file path inside the run directory. */
export function reportPath(run: ReportRun, ...segments: string[]): string {
  return resolve(run.dir, ...segments);
}

/**
 * Append one JSON line to a JSONL file (creates parent directories on demand).
 */
export function appendJsonl(path: string, row: unknown): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n", "utf8");
}

/**
 * Write a CSV file from a row array + header definition.
 *
 * The header list is the source of truth — every row must contain
 * every header key, but extra fields on rows are silently dropped so
 * the schema stays stable across runs.
 */
export function writeCsv(
  path: string,
  headers: readonly string[],
  rows: readonly Record<string, unknown>[],
): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const lines: string[] = [headers.join(",")];
  for (const row of rows) {
    const cells = headers.map((h) => formatCsvCell(row[h]));
    lines.push(cells.join(","));
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}

function formatCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (Number.isFinite(value)) return String(value);
    return "";
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  const raw = String(value);
  if (/[",\n\r]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

/**
 * Write a small markdown summary of an experiment run — easy operator
 * read-out. Always overwrites; designed to be the first thing the
 * operator looks at.
 */
export function writeMarkdownSummary(path: string, lines: readonly string[]): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}
