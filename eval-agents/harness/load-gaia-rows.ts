import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { GaiaRow } from "./gaia-types.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DATASETS_ROOT = resolve(HERE, "..", "datasets", "gaia");

export interface LoadGaiaOptions {
  /** `fixtures` (committed smoke) or `hf` (downloaded validation). */
  source?: "fixtures" | "hf" | "auto";
  level?: number | null;
  limit?: number | null;
  split?: "validation" | "test";
  /**
   * Optional allowlist of `task_id`s. When provided, only matching rows are
   * kept (applied after the `level` filter, before `limit`). Used to resume a
   * partially-completed matrix run without re-executing finished cases.
   */
  taskIds?: readonly string[] | null;
}

export function resolveGaiaHfRoot(): string {
  return join(DATASETS_ROOT, "hf");
}

export function loadGaiaRows(opts: LoadGaiaOptions = {}): GaiaRow[] {
  const source = opts.source ?? "auto";
  const level = opts.level ?? null;
  const limit = opts.limit ?? null;

  let rows: GaiaRow[] = [];
  if (source === "fixtures" || (source === "auto" && !hasHfMetadata())) {
    rows = loadFixtureRows();
  } else {
    rows = loadHfRows(opts.split ?? "validation");
  }

  if (level !== null) {
    rows = rows.filter((row) => Number(row.Level) === level);
  }
  if (opts.taskIds && opts.taskIds.length > 0) {
    const allow = new Set(opts.taskIds);
    rows = rows.filter((row) => allow.has(row.task_id));
  }
  if (limit !== null && limit > 0) {
    rows = rows.slice(0, limit);
  }
  return rows;
}

function hasHfMetadata(): boolean {
  return existsSync(join(resolveGaiaHfRoot(), "2023", "validation", "metadata.jsonl"));
}

function loadFixtureRows(): GaiaRow[] {
  const path = join(DATASETS_ROOT, "fixtures", "smoke-level1.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as GaiaRow[];
  return raw.map(normalizeRow);
}

function loadHfRows(split: "validation" | "test"): GaiaRow[] {
  const jsonlPath = join(resolveGaiaHfRoot(), "2023", split, "metadata.jsonl");
  if (!existsSync(jsonlPath)) {
    throw new Error(
      `GAIA metadata missing at ${jsonlPath}. Run: npm run eval:agents:datasets`,
    );
  }
  const lines = readFileSync(jsonlPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.map((line) => normalizeRow(JSON.parse(line) as GaiaRow));
}

function normalizeRow(row: GaiaRow): GaiaRow {
  return {
    ...row,
    Level: Number(row.Level),
    file_name: row.file_name ?? "",
    file_path: row.file_path ?? "",
  };
}

export function resolveAttachmentPath(row: GaiaRow, split: "validation" | "test"): string | null {
  if (row.fixture_file_text) {
    return row.file_name || null;
  }
  if (!row.file_name && !row.file_path) return null;
  const rel = row.file_path || row.file_name;
  const abs = join(resolveGaiaHfRoot(), "2023", split, rel);
  if (existsSync(abs)) return abs;
  const byName = join(resolveGaiaHfRoot(), "2023", split, row.file_name);
  if (existsSync(byName)) return byName;
  return null;
}
