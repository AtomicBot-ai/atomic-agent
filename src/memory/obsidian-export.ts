/**
 * One-way export of the cross-session memory corpus (`memory.sqlite`)
 * into an Obsidian vault as plain markdown.
 *
 * Design decisions (v1, `memory export` CLI):
 *
 *  - **One-way, read-only.** The database is opened with
 *    `{ readonly: true }` and migrations are *not* applied — an export
 *    must never mutate agent state, not even a schema bump. Tables
 *    that predate the current schema (`lessons`, `procedures`,
 *    `memory_links`) are treated as empty when absent, and rows are
 *    read via `SELECT *` so missing columns degrade to `undefined`
 *    instead of a thrown error.
 *
 *  - **Stable, id-based filenames.** `notes/note-<id>.md`,
 *    `lessons/lesson-<id>.md`, `procedures/procedure-<id>.md` under a
 *    single export folder inside the vault. Ids are AUTOINCREMENT so a
 *    record keeps its filename (and therefore its Obsidian identity,
 *    backlinks included) across re-exports. Obsidian resolves
 *    `[[note-17]]` by basename regardless of folder.
 *
 *  - **Idempotent + overwrite-safe.** File content is a pure function
 *    of the database row (no export timestamps), files are rewritten
 *    only when their bytes actually changed (stable mtimes for vault
 *    sync tools), and pruning of stale files is restricted to names
 *    matching the machine-owned `note-<n>.md` / `lesson-<n>.md` /
 *    `procedure-<n>.md` patterns inside the three export subfolders.
 *    Anything else the user keeps in those folders is never touched.
 *
 *  - **Wikilinks follow the schema's own edges.** `memory_links` rows
 *    become a `## Links` section on the source note; `consolidated_into`
 *    points a note at its lesson; `lessons.parent_ids` and
 *    `procedures.parent_lesson_ids` / `parent_memory_ids` become
 *    `## Sources` sections. Soft pointers whose target row no longer
 *    exists (evicted episodes) are skipped rather than rendered as
 *    dangling links.
 *
 * No watch mode, no sync-back, no conflict handling — a re-export
 * overwrites the exported files, full stop.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";

export const DEFAULT_EXPORT_FOLDER = "atomic-agent";

/**
 * Invalid-argument errors (bad `folder`, …) — the CLI maps these to
 * exit code 2 (usage) while every other throw stays an operational
 * failure (exit code 1).
 */
export class ObsidianExportUsageError extends Error {}

export interface ObsidianExportOptions {
  /** Path to `memory.sqlite` (usually `getConfig().paths.memoryDbFile`). */
  dbFile: string;
  /** Existing Obsidian vault directory. Never created by the export. */
  vaultDir: string;
  /**
   * Subfolder of the vault that the export owns. Default
   * `atomic-agent`. Must stay inside the vault and must not be the
   * vault root itself — the pruning pass only runs inside this
   * folder's `notes/` / `lessons/` / `procedures/` subfolders.
   */
  folder?: string;
}

export interface ObsidianExportResult {
  /** Absolute path of the export folder inside the vault. */
  root: string;
  notes: number;
  lessons: number;
  procedures: number;
  /** Stale machine-owned files removed because their record is gone. */
  pruned: number;
}

interface Row {
  [column: string]: unknown;
}

const NOTE_FILE = /^note-(\d+)\.md$/;
const LESSON_FILE = /^lesson-(\d+)\.md$/;
const PROCEDURE_FILE = /^procedure-(\d+)\.md$/;

export function exportMemoryToObsidian(
  options: ObsidianExportOptions,
): ObsidianExportResult {
  const root = resolveExportRoot(options.vaultDir, options.folder);
  if (!existsSync(options.dbFile)) {
    throw new Error(
      `no memory database at ${options.dbFile} — nothing to export`,
    );
  }
  if (!existsSync(options.vaultDir)) {
    throw new Error(
      `vault directory does not exist: ${options.vaultDir} (pass an existing Obsidian vault — the export never creates one)`,
    );
  }

  const db = new DatabaseCtor(options.dbFile, {
    readonly: true,
    fileMustExist: true,
  }) as Database.Database;
  let notes: Row[];
  let lessons: Row[];
  let procedures: Row[];
  let links: Row[];
  try {
    notes = readAll(db, "memories", "id");
    lessons = readAll(db, "lessons", "id");
    procedures = readAll(db, "procedures", "id");
    links = readAll(db, "memory_links", "from_id, to_id, kind");
  } finally {
    db.close();
  }

  const noteIds = new Set(notes.map((r) => asId(r.id)));
  const lessonIds = new Set(lessons.map((r) => asId(r.id)));
  const procedureIds = new Set(procedures.map((r) => asId(r.id)));

  const linksByFrom = new Map<number, Row[]>();
  for (const link of links) {
    const from = asId(link.from_id);
    const bucket = linksByFrom.get(from);
    if (bucket) bucket.push(link);
    else linksByFrom.set(from, [link]);
  }

  const notesDir = join(root, "notes");
  const lessonsDir = join(root, "lessons");
  const proceduresDir = join(root, "procedures");
  mkdirSync(notesDir, { recursive: true });
  mkdirSync(lessonsDir, { recursive: true });
  mkdirSync(proceduresDir, { recursive: true });

  for (const row of notes) {
    const id = asId(row.id);
    writeIfChanged(
      join(notesDir, `note-${id}.md`),
      renderNote(row, linksByFrom.get(id) ?? [], noteIds, lessonIds),
    );
  }
  for (const row of lessons) {
    const id = asId(row.id);
    writeIfChanged(join(lessonsDir, `lesson-${id}.md`), renderLesson(row, noteIds));
  }
  for (const row of procedures) {
    const id = asId(row.id);
    writeIfChanged(
      join(proceduresDir, `procedure-${id}.md`),
      renderProcedure(row, noteIds, lessonIds),
    );
  }

  const pruned =
    pruneStale(notesDir, NOTE_FILE, noteIds) +
    pruneStale(lessonsDir, LESSON_FILE, lessonIds) +
    pruneStale(proceduresDir, PROCEDURE_FILE, procedureIds);

  return {
    root,
    notes: notes.length,
    lessons: lessons.length,
    procedures: procedures.length,
    pruned,
  };
}

function resolveExportRoot(vaultDir: string, folder: string | undefined): string {
  const name = folder ?? DEFAULT_EXPORT_FOLDER;
  if (name.trim().length === 0) {
    throw new ObsidianExportUsageError("--folder must not be empty");
  }
  const vault = resolve(vaultDir);
  const root = resolve(vault, name);
  if (root === vault || !root.startsWith(vault + sep)) {
    throw new ObsidianExportUsageError(
      `--folder must name a subfolder inside the vault, got: ${name}`,
    );
  }
  return root;
}

function readAll(db: Database.Database, table: string, orderBy: string): Row[] {
  const present = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  if (present === undefined) return [];
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all() as Row[];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderNote(
  row: Row,
  outgoing: Row[],
  noteIds: Set<number>,
  lessonIds: Set<number>,
): string {
  const lines = [
    "---",
    "type: memory-note",
    `id: ${asId(row.id)}`,
    `created: ${isoDate(row.created_at)}`,
    `updated: ${isoDate(row.updated_at)}`,
    `source: ${yamlScalar(asOptionalString(row.source) ?? "agent")}`,
    ...yamlTags(parseStringArray(row.tags)),
    "---",
    "",
    asOptionalString(row.content) ?? "",
  ];

  const linkLines: string[] = [];
  for (const link of outgoing) {
    const to = asId(link.to_id);
    if (!noteIds.has(to)) continue;
    linkLines.push(`- ${linkKindLabel(link.kind)} [[note-${to}]]`);
  }
  const consolidatedInto = asOptionalId(row.consolidated_into);
  if (consolidatedInto !== null && lessonIds.has(consolidatedInto)) {
    linkLines.push(`- consolidated into [[lesson-${consolidatedInto}]]`);
  }
  if (linkLines.length > 0) {
    lines.push("", "## Links", "", ...linkLines);
  }
  lines.push("");
  return lines.join("\n");
}

function renderLesson(row: Row, noteIds: Set<number>): string {
  const lines = [
    "---",
    "type: memory-lesson",
    `id: ${asId(row.id)}`,
    `created: ${isoDate(row.created_at)}`,
    `updated: ${isoDate(row.updated_at)}`,
    `status: ${yamlScalar(asOptionalString(row.status) ?? "active")}`,
    ...yamlTags(parseStringArray(row.tags)),
    "---",
    "",
    `**When:** ${asOptionalString(row.activation) ?? ""}`,
    "",
    asOptionalString(row.principle) ?? "",
  ];
  const sources = parseNumberArray(row.parent_ids).filter((id) =>
    noteIds.has(id),
  );
  if (sources.length > 0) {
    lines.push("", "## Sources", "", ...sources.map((id) => `- [[note-${id}]]`));
  }
  lines.push("");
  return lines.join("\n");
}

function renderProcedure(
  row: Row,
  noteIds: Set<number>,
  lessonIds: Set<number>,
): string {
  const lines = [
    "---",
    "type: memory-procedure",
    `id: ${asId(row.id)}`,
    `created: ${isoDate(row.created_at)}`,
    `updated: ${isoDate(row.updated_at)}`,
    `status: ${yamlScalar(asOptionalString(row.status) ?? "active")}`,
    `source: ${yamlScalar(asOptionalString(row.source) ?? "consolidator")}`,
    ...yamlTags(parseStringArray(row.tags)),
    "---",
    "",
    `**When:** ${asOptionalString(row.activation) ?? ""}`,
  ];
  const steps = parseSteps(row.steps);
  if (steps.length > 0) {
    lines.push("", "## Steps", "");
    steps.forEach((step, index) => {
      const hint = step.toolHint ? ` (\`${step.toolHint}\`)` : "";
      lines.push(`${index + 1}. ${step.description}${hint}`);
    });
  }
  const sourceLines = [
    ...parseNumberArray(row.parent_lesson_ids)
      .filter((id) => lessonIds.has(id))
      .map((id) => `- [[lesson-${id}]]`),
    ...parseNumberArray(row.parent_memory_ids)
      .filter((id) => noteIds.has(id))
      .map((id) => `- [[note-${id}]]`),
  ];
  if (sourceLines.length > 0) {
    lines.push("", "## Sources", "", ...sourceLines);
  }
  lines.push("");
  return lines.join("\n");
}

/** `RELATES_TO` → `relates to` — a human-readable edge label. */
function linkKindLabel(kind: unknown): string {
  const raw = asOptionalString(kind) ?? "relates to";
  return raw.toLowerCase().replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// YAML helpers — double-quoted JSON scalars are valid YAML, so the
// escaping burden collapses onto JSON.stringify.
// ---------------------------------------------------------------------------

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function yamlTags(tags: string[]): string[] {
  if (tags.length === 0) return ["tags: []"];
  return ["tags:", ...tags.map((tag) => `  - ${yamlScalar(tag)}`)];
}

// ---------------------------------------------------------------------------
// Defensive row decoding — the export must survive rows written by any
// past schema version, so every accessor tolerates missing / malformed
// values instead of trusting the current column shapes.
// ---------------------------------------------------------------------------

function asId(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`memory export: non-numeric row id: ${String(value)}`);
  }
  return n;
}

function asOptionalId(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isoDate(value: unknown): string {
  const n = Number(value);
  const ms = Number.isFinite(n) ? n : 0;
  return new Date(ms).toISOString();
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function parseNumberArray(raw: unknown): number[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item));
  } catch {
    return [];
  }
}

function parseSteps(raw: unknown): { description: string; toolHint: string | null }[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const steps: { description: string; toolHint: string | null }[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const description = (item as Row).description;
      if (typeof description !== "string") continue;
      const toolHint = (item as Row).toolHint;
      steps.push({
        description,
        toolHint: typeof toolHint === "string" && toolHint.length > 0 ? toolHint : null,
      });
    }
    return steps;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/** Skip the write when bytes match so vault-sync tools see stable mtimes. */
function writeIfChanged(path: string, content: string): void {
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf8") === content) return;
    } catch {
      // Unreadable existing file — fall through to the overwrite.
    }
  }
  writeFileSync(path, content);
}

/**
 * Remove machine-owned files whose record no longer exists. Only exact
 * `<kind>-<n>.md` names are candidates — the user's own files in the
 * export folders are never touched.
 */
function pruneStale(dir: string, pattern: RegExp, liveIds: Set<number>): number {
  let pruned = 0;
  for (const name of readdirSync(dir)) {
    const match = pattern.exec(name);
    if (!match) continue;
    const id = Number(match[1]);
    if (liveIds.has(id)) continue;
    rmSync(join(dir, name));
    pruned += 1;
  }
  return pruned;
}
