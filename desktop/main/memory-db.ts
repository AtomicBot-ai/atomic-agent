import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Item 7 part B (Memory tab): read-only SQL over <stateDir>/memory.sqlite.
 *
 * `atag memory` on 0.5.4 has only `export --vault`, and no HTTP route
 * reads the stores, so the tab reads the database the TUI's stores read —
 * with their own statements. The renderer never sends SQL: it names one
 * of the statements below and passes typed parameters, which are bound
 * (node:sqlite) or inlined as validated literals (`/usr/bin/sqlite3`).
 *
 * The SQL is copied from src/memory (profile-store.ts, memory-store.ts,
 * lessons/lesson-store.ts, procedures/procedure-store.ts,
 * links/link-store.ts, voting/vote-store.ts). Two read-side differences
 * from the stores: `notes.recall` does not bump `recall_count` (the store's
 * `touchOnRecall` is a write) and the store limits are inlined by the
 * renderer as the TUI's memory-orchestrator passes them.
 */

type ParamKind = "int" | "text";
interface NamedStatement { sql: string; params: ParamKind[] }

const PROFILE_COLS = "id, key, value, pinned, keywords, valid_from, superseded_by, supersedes, created_at, updated_at, vote_score";
const NOTE_COLS = "id, content, created_at, updated_at, source, session_id, working_dir, tags, recall_count, last_recalled_at, consolidated_into";
const LESSON_COLS = "id, activation, principle, tags, status, success_count, failure_count, parent_ids, working_dir, created_at, updated_at, deprecated_at, vote_score";
const PROC_COLS = "id, activation, steps, tags, status, success_count, failure_count, use_count, vote_score, parent_lesson_ids, parent_memory_ids, source, working_dir, created_at, updated_at, deprecated_at";
const LINK_COLS = "from_id, to_id, kind, weight, created_at";

export const MEMORY_SQL: Record<string, NamedStatement> = {
  // profile-store.ts selectAllActiveStmt / historyByKeyStmt / selectActiveByIdStmt
  "profile.list": { sql: `SELECT ${PROFILE_COLS} FROM profile_facts WHERE superseded_by IS NULL ORDER BY key ASC`, params: [] },
  "profile.history": { sql: `SELECT ${PROFILE_COLS} FROM profile_facts WHERE key = ? ORDER BY valid_from ASC, id ASC`, params: ["text"] },
  "profile.getById": { sql: `SELECT ${PROFILE_COLS} FROM profile_facts WHERE id = ?`, params: ["int"] },
  // memory-store.ts list() (excludeArchived → consolidated_into IS NULL), getStmt, recall()
  "notes.listActive": { sql: `SELECT ${NOTE_COLS} FROM memories WHERE consolidated_into IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?`, params: ["int"] },
  "notes.listAll": { sql: `SELECT ${NOTE_COLS} FROM memories ORDER BY updated_at DESC, id DESC LIMIT ?`, params: ["int"] },
  "notes.get": { sql: `SELECT ${NOTE_COLS} FROM memories WHERE id = ?`, params: ["int"] },
  "notes.recall": {
    sql: `SELECT m.id, m.content, m.created_at, m.updated_at, m.source, m.session_id, m.working_dir, m.tags, m.recall_count, m.last_recalled_at, m.consolidated_into FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) ASC LIMIT ?`,
    params: ["text", "int"],
  },
  // lesson-store.ts listActiveStmt / getByIdStmt
  "lessons.listIndex": { sql: `SELECT id, activation, tags, working_dir, updated_at FROM lessons WHERE status = 'active' ORDER BY updated_at DESC, id DESC LIMIT ?`, params: ["int"] },
  "lessons.getById": { sql: `SELECT ${LESSON_COLS} FROM lessons WHERE id = ?`, params: ["int"] },
  // procedure-store.ts listActiveStmt / getByIdStmt
  "procedures.listIndex": { sql: `SELECT id, activation, tags, working_dir, updated_at, vote_score FROM procedures WHERE status = 'active' ORDER BY vote_score DESC, updated_at DESC, id DESC LIMIT ?`, params: ["int"] },
  "procedures.getById": { sql: `SELECT ${PROC_COLS} FROM procedures WHERE id = ?`, params: ["int"] },
  // link-store.ts listAllStmt / listOutgoingAllStmt / listIncomingAllStmt
  "links.listAll": { sql: `SELECT ${LINK_COLS} FROM memory_links ORDER BY created_at DESC LIMIT ?`, params: ["int"] },
  "links.outgoing": { sql: `SELECT ${LINK_COLS} FROM memory_links WHERE from_id = ? ORDER BY weight DESC, created_at DESC`, params: ["int"] },
  "links.incoming": { sql: `SELECT ${LINK_COLS} FROM memory_links WHERE to_id = ? ORDER BY weight DESC, created_at DESC`, params: ["int"] },
  // vote-store.ts listEvents
  "votes.listEvents": {
    sql: `SELECT id, kind, target_id AS targetId, direction, session_id AS sessionId, turn_index AS turnIndex, created_at AS createdAt FROM vote_events ORDER BY id DESC LIMIT ?`,
    params: ["int"],
  },
};

export type MemoryRow = Record<string, unknown>;

function coerce(kind: ParamKind, raw: unknown): number | string | null {
  if (kind === "int") {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 1e12) return null;
    return raw;
  }
  if (typeof raw !== "string" || raw.length > 4000 || raw.includes("\0")) return null;
  return raw;
}

/** A validated parameter as a SQL literal, for the CLI path (no binding there). */
function literal(kind: ParamKind, v: number | string): string {
  return kind === "int" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
}

const SQLITE3 = "/usr/bin/sqlite3";

async function viaCli(file: string, sql: string): Promise<MemoryRow[]> {
  const { stdout } = await run(SQLITE3, ["-readonly", "-json", file, sql], {
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? (parsed as MemoryRow[]) : [];
}

/** node:sqlite (Node ≥ 22.13; Electron 44 carries Node 24), read-only. */
function viaNodeSqlite(file: string, sql: string, params: Array<number | string>): MemoryRow[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("node:sqlite") as {
    DatabaseSync: new (path: string, opts: { readOnly: boolean }) => {
      prepare(sql: string): { all(...args: Array<number | string>): MemoryRow[] };
      close(): void;
    };
  };
  const db = new mod.DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

export async function memoryQuery(
  stateDir: string,
  name: string,
  rawParams: unknown[],
): Promise<{ ok: boolean; rows?: MemoryRow[]; via?: "sqlite3" | "node:sqlite"; error?: string }> {
  const stmt = Object.hasOwn(MEMORY_SQL, name) ? MEMORY_SQL[name] : undefined;
  if (!stmt) return { ok: false, error: `unknown memory statement: ${name}` };
  if (!stateDir || !isAbsolute(stateDir) || stateDir.includes("\0")) return { ok: false, error: "no state dir" };
  const file = join(stateDir, "memory.sqlite");
  if (!existsSync(file)) return { ok: false, error: `no memory.sqlite at ${stateDir}` };
  if (!Array.isArray(rawParams) || rawParams.length !== stmt.params.length) {
    return { ok: false, error: `${name} takes ${stmt.params.length} parameter(s)` };
  }
  const params: Array<number | string> = [];
  for (let i = 0; i < stmt.params.length; i++) {
    const v = coerce(stmt.params[i]!, rawParams[i]);
    if (v === null) return { ok: false, error: `${name}: parameter ${i + 1} must be ${stmt.params[i]}` };
    params.push(v);
  }
  let cliError = "";
  if (existsSync(SQLITE3)) {
    let idx = 0;
    const inlined = stmt.sql.replace(/\?/g, () => literal(stmt.params[idx]!, params[idx++]!));
    try {
      return { ok: true, rows: await viaCli(file, inlined), via: "sqlite3" };
    } catch (err) {
      cliError = err instanceof Error ? err.message : String(err);
    }
  }
  try {
    return { ok: true, rows: viaNodeSqlite(file, stmt.sql, params), via: "node:sqlite" };
  } catch (err) {
    const nodeError = err instanceof Error ? err.message : String(err);
    return { ok: false, error: cliError ? `sqlite3: ${cliError}; node:sqlite: ${nodeError}` : nodeError };
  }
}
