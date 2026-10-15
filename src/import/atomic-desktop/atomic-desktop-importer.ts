import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type BetterSqlite3 from "better-sqlite3";

import {
  MEMORY_CONTENT_MAX_LENGTH,
  MemoryValidationError,
  ProfileStore,
  ProfileValidationError,
  type MemoryStore,
  type MemorySource,
  type ProfileFact,
  type ProfileSetOptions,
} from "../../memory/index.js";
import { Database as DatabaseCtor } from "../../native/load-better-sqlite3.js";
import { normalizeSessionState, type SessionStore } from "../../session/index.js";
import type { SessionState, SessionStatus } from "../../session/session-state.js";
import { TaskStore } from "../../tasks/index.js";
import { splitMemoryNote } from "../split-note.js";
import { snapshotSqlite } from "./sqlite-snapshot.js";

/**
 * The databases of an Atomic Agent state dir this importer reads. The
 * desktop app kept them in its own state dir (`~/.atomic-agent-desktop`)
 * before it moved onto the terminal agent's (ATO-416); the desktop
 * itself moves the plain files (config, `.env`, skills, traces, models).
 */
export const ATOMIC_DESKTOP_DB_FILES = {
  sessions: "sessions.sqlite",
  tasks: "tasks.sqlite",
  memory: "memory.sqlite",
} as const;

/**
 * What is deliberately left behind. Their rows are tied to the source's
 * note ids (AUTOINCREMENT integers that differ in the target), so they
 * cannot be copied; the agent forms them again from the imported notes.
 * Note embeddings are rebuilt by the embedding backfill / `memory reindex`.
 */
export const ATOMIC_DESKTOP_NOT_IMPORTED = [
  "lessons",
  "procedures",
  "votes",
  "note links",
  "note embeddings",
] as const;

export interface AtomicDesktopImportCounts {
  imported: number;
  skipped: number;
}

export interface AtomicDesktopImportResult {
  /** `false` when any part failed or the source could not be used. */
  ok: boolean;
  sessions: AtomicDesktopImportCounts;
  tasks: AtomicDesktopImportCounts;
  /** Counted per source note; a note too long for the cap lands as several. */
  notes: AtomicDesktopImportCounts;
  profileFacts: AtomicDesktopImportCounts;
  /** Things the operator should know that did not stop the import. */
  warnings: string[];
  /** Why a part (or the whole import) failed; empty when `ok`. */
  errors: string[];
}

/** The target state dir's stores, open on its databases. */
export interface AtomicDesktopImportTargets {
  sessionStore: SessionStore;
  taskStore: TaskStore;
  memoryStore: MemoryStore;
  profileStore: ProfileStore;
}

export interface ImportAtomicDesktopOptions {
  /** The old desktop state dir. Only read, never written. */
  sourceDir: string;
  /** The state dir the target stores live in; refused when it is the source. */
  targetStateDir: string;
  targets: AtomicDesktopImportTargets;
  /** Where the private snapshots are made (default the OS temp dir). */
  scratchParent?: string;
  /** Rows per write transaction (default 200), so no lock is held for long. */
  batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 200;

/**
 * Why `sourceDir` cannot be merged into `targetStateDir`, or `null` when
 * it can: it must be an existing directory other than the target.
 */
export function checkAtomicDesktopSource(
  sourceDir: string,
  targetStateDir: string,
): string | null {
  const source = resolve(sourceDir);
  if (!existsSync(source)) return `source dir does not exist: ${source}`;
  if (!statSync(source).isDirectory()) {
    return `source is not a directory: ${source}`;
  }
  if (sameDir(source, resolve(targetStateDir))) {
    return `source dir is the target state dir (${source}); nothing to merge`;
  }
  return null;
}

/**
 * Merge an old desktop state dir's databases into the target stores,
 * once and safely re-runnable (ATO-416):
 *
 * - sessions and tasks keep their TEXT ids and are inserted only where
 *   the id is absent (the target wins); a turn or run that was live in
 *   the source arrives ended / back to `pending`, with no owner mark.
 * - memory notes go through `MemoryStore.store` with exact-content
 *   dedup, keeping tags, session, working dir, source and time.
 * - profile facts go through `ProfileStore.set`; a key the target has
 *   any row for (active, or history of a removed value) stays the target's.
 * - lessons, procedures, votes, links and embeddings are not copied
 *   (`ATOMIC_DESKTOP_NOT_IMPORTED`).
 *
 * Every source database is read from a private snapshot
 * (`snapshotSqlite`), so the source is never written and may still be
 * open elsewhere. The parts run independently: one that fails is
 * reported in `errors` and the others still import.
 */
export async function importAtomicDesktop(
  options: ImportAtomicDesktopOptions,
): Promise<AtomicDesktopImportResult> {
  const result: AtomicDesktopImportResult = {
    ok: false,
    sessions: { imported: 0, skipped: 0 },
    tasks: { imported: 0, skipped: 0 },
    notes: { imported: 0, skipped: 0 },
    profileFacts: { imported: 0, skipped: 0 },
    warnings: [],
    errors: [],
  };
  const problem = checkAtomicDesktopSource(
    options.sourceDir,
    options.targetStateDir,
  );
  if (problem !== null) {
    result.errors.push(problem);
    return result;
  }
  const sourceDir = resolve(options.sourceDir);
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const { targets } = options;
  const scratch = mkdtempSync(
    join(options.scratchParent ?? tmpdir(), "atomic-desktop-import-"),
  );

  const part = async (
    name: string,
    file: string,
    run: (snapshotFile: string) => void,
  ): Promise<void> => {
    const sourceFile = join(sourceDir, file);
    if (!existsSync(sourceFile)) {
      result.warnings.push(`no ${file} in the source; no ${name} to import`);
      return;
    }
    try {
      const snapshotFile = join(scratch, file);
      await snapshotSqlite(sourceFile, snapshotFile);
      run(snapshotFile);
    } catch (err) {
      result.errors.push(`${name}: ${errorMessage(err)}`);
    }
  };

  try {
    // Sessions before tasks: a copied task names its session by id.
    await part("sessions", ATOMIC_DESKTOP_DB_FILES.sessions, (file) =>
      importSessions(file, targets.sessionStore, result, batchSize),
    );
    await part("tasks", ATOMIC_DESKTOP_DB_FILES.tasks, (file) =>
      importTasks(file, targets.taskStore, result, batchSize),
    );
    await part("memory", ATOMIC_DESKTOP_DB_FILES.memory, (file) =>
      importMemory(file, targets, result),
    );
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch (err) {
      result.warnings.push(
        `could not remove the snapshot dir ${scratch}: ${errorMessage(err)}`,
      );
    }
  }
  result.ok = result.errors.length === 0;
  return result;
}

interface SessionRow {
  id: string;
  working_dir: string;
  status: unknown;
  payload: string;
  created_at: number;
  updated_at: number;
}

function importSessions(
  snapshotFile: string,
  store: SessionStore,
  result: AtomicDesktopImportResult,
  batchSize: number,
): void {
  const counts = result.sessions;
  const db = new DatabaseCtor(snapshotFile, { fileMustExist: true });
  try {
    if (!hasTable(db, "sessions")) {
      result.warnings.push("the source sessions.sqlite has no sessions table");
      return;
    }
    let batch: SessionState[] = [];
    const flush = (): void => {
      if (batch.length === 0) return;
      const inserted = store.insertMissing(batch).length;
      counts.imported += inserted;
      counts.skipped += batch.length - inserted;
      batch = [];
    };
    let unreadable = 0;
    const rows = db
      .prepare(
        `SELECT id, working_dir, status, payload, created_at, updated_at
           FROM sessions ORDER BY created_at ASC, id ASC`,
      )
      .iterate() as IterableIterator<SessionRow>;
    for (const row of rows) {
      let state: SessionState;
      try {
        state = normalizeSessionState(JSON.parse(row.payload));
      } catch {
        unreadable += 1;
        counts.skipped += 1;
        continue;
      }
      // The columns are what the row is keyed, listed and ordered by,
      // and the status lives there (see `SessionStore.readPayload`); a
      // payload that lacks one of them must not fail the whole batch.
      state = {
        ...state,
        id: row.id,
        workingDir: row.working_dir,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(typeof row.status === "string"
          ? { status: row.status as SessionStatus }
          : {}),
      };
      batch.push(state);
      if (batch.length >= batchSize) flush();
    }
    flush();
    if (unreadable > 0) {
      result.warnings.push(
        `${unreadable} source session(s) could not be read and were skipped`,
      );
    }
  } finally {
    db.close();
  }
}

function importTasks(
  snapshotFile: string,
  store: TaskStore,
  result: AtomicDesktopImportResult,
  batchSize: number,
): void {
  const counts = result.tasks;
  // Opening the store migrates the private copy to this binary's schema.
  const source = new TaskStore({ dbFile: snapshotFile });
  try {
    const records = source.list({ limit: Number.MAX_SAFE_INTEGER }).reverse();
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const inserted = store.insertMissing(batch).length;
      counts.imported += inserted;
      counts.skipped += batch.length - inserted;
    }
  } finally {
    source.close();
  }
}

interface NoteRow {
  content: string;
  updated_at: number;
  source: string;
  session_id: string | null;
  working_dir: string | null;
  tags: string | null;
}

function importMemory(
  snapshotFile: string,
  targets: AtomicDesktopImportTargets,
  result: AtomicDesktopImportResult,
): void {
  // Opening the store migrates the private copy to this binary's schema,
  // so the note query below can name current columns.
  const sourceProfile = new ProfileStore({ dbFile: snapshotFile });
  let facts: ProfileFact[];
  let notes: NoteRow[];
  try {
    facts = sourceProfile.list();
  } finally {
    sourceProfile.close();
  }
  const db = new DatabaseCtor(snapshotFile, { fileMustExist: true });
  try {
    // Archived notes too: the lessons they were distilled into stay
    // behind, so the notes are what carries that knowledge over.
    notes = db
      .prepare(
        `SELECT content, updated_at, source, session_id, working_dir, tags
           FROM memories ORDER BY updated_at ASC, id ASC`,
      )
      .all() as NoteRow[];
  } finally {
    db.close();
  }
  // Independent halves: a failure in one still lets the other import.
  try {
    importNotes(notes, targets.memoryStore, result);
  } catch (err) {
    result.errors.push(`notes: ${errorMessage(err)}`);
  }
  try {
    importProfileFacts(facts, targets.profileStore, result);
  } catch (err) {
    result.errors.push(`profile facts: ${errorMessage(err)}`);
  }
}

function importNotes(
  notes: readonly NoteRow[],
  store: MemoryStore,
  result: AtomicDesktopImportResult,
): void {
  const counts = result.notes;
  const before = store.count();
  let stored = 0;
  let invalid = 0;
  let tagsDropped = 0;
  for (const note of notes) {
    const chunks = splitMemoryNote(note.content, MEMORY_CONTENT_MAX_LENGTH);
    const missing = chunks.filter((chunk) => !store.hasContent(chunk));
    if (missing.length === 0) {
      counts.skipped += 1;
      continue;
    }
    const base = {
      sessionId: note.session_id,
      workingDir: note.working_dir,
      source: (note.source === "user" ? "user" : "agent") as MemorySource,
    };
    let tags = parseTags(note.tags);
    try {
      for (const content of missing) {
        try {
          // The source's time, so the merged list keeps its order.
          store.store({ ...base, content, tags }, note.updated_at);
        } catch (err) {
          if (!(err instanceof MemoryValidationError) || tags.length === 0) {
            throw err;
          }
          // Retried bare: if the content was the problem, this throws too.
          store.store({ ...base, content, tags: [] }, note.updated_at);
          tags = [];
          tagsDropped += 1;
        }
        stored += 1;
      }
      counts.imported += 1;
    } catch (err) {
      if (!(err instanceof MemoryValidationError)) throw err;
      invalid += 1;
      counts.skipped += 1;
    }
  }
  if (invalid > 0) {
    result.warnings.push(
      `${invalid} source note(s) were rejected by the memory store and skipped`,
    );
  }
  if (tagsDropped > 0) {
    result.warnings.push(
      `${tagsDropped} source note(s) had tags the memory store rejects; imported without tags`,
    );
  }
  const evicted = before + stored - store.count();
  if (evicted > 0) {
    result.warnings.push(
      `${evicted} note(s) were evicted to keep memory under memory.notes.maxEntries`,
    );
  }
}

function importProfileFacts(
  facts: readonly ProfileFact[],
  store: ProfileStore,
  result: AtomicDesktopImportResult,
): void {
  const counts = result.profileFacts;
  let invalid = 0;
  const ordered = [...facts].sort((a, b) => a.validFrom - b.validFrom);
  for (const fact of ordered) {
    try {
      // Any row for the key: an active value, or the history of one
      // changed and then removed here. Either way the target's word on
      // the key stands. (A single-version fact removed here leaves no
      // row, so the desktop's value is imported.)
      if (store.history(fact.key).length > 0) {
        counts.skipped += 1;
        continue;
      }
      const options: ProfileSetOptions = {
        pinned: fact.pinned,
        keywords: fact.keywords,
      };
      // A positive verdict carries over; an `ungrounded` one (or none) is
      // left for the startup check, which now also reads the imported
      // sessions.
      if (
        fact.nameGrounding === "grounded" ||
        fact.nameGrounding === "unverifiable"
      ) {
        options.nameGrounding = fact.nameGrounding;
      }
      store.set(fact.key, fact.value, options, fact.validFrom);
      counts.imported += 1;
    } catch (err) {
      if (!(err instanceof ProfileValidationError)) throw err;
      invalid += 1;
      counts.skipped += 1;
    }
  }
  if (invalid > 0) {
    result.warnings.push(
      `${invalid} source profile fact(s) were rejected by the profile store and skipped`,
    );
  }
}

function hasTable(db: BetterSqlite3.Database, name: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  );
}

function parseTags(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

function sameDir(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
