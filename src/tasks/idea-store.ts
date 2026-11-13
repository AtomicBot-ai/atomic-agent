import type Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { Database as DatabaseCtor } from "../native/load-better-sqlite3.js";

import {
  IDEA_STATUSES,
  IDEAS_PER_KIND_MAX,
  IdeaStateError,
  type IdeaCandidate,
  type IdeaEvidence,
  type IdeaKind,
  type IdeaRecord,
  type IdeaStatus,
} from "./idea-types.js";

/**
 * Durable store of suggestions (ATO-458), next to the tasks they turn
 * into. A table of its own in `tasks.sqlite`, created with `IF NOT
 * EXISTS` on open like `held_task_reports`: no foreign key to `tasks`
 * and outside the versioned task schema, so it never collides with the
 * task-row migrations. Own connection on the same file (WAL).
 *
 * `source_key` is UNIQUE: a source that has had an idea, new, accepted
 * or dismissed, never gets another one. That is the "do not suggest
 * what is done or dismissed" rule, enforced by the database.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS ideas (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  source_key    TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  reason        TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  session_id    TEXT,
  status        TEXT NOT NULL,
  task_id       TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  decided_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ideas_status_created ON ideas(status, created_at);
`;

interface IdeaRow {
  id: string;
  kind: string;
  source_key: string;
  title: string;
  reason: string;
  evidence_json: string;
  prompt: string;
  session_id: string | null;
  status: string;
  task_id: string | null;
  created_at: number;
  updated_at: number;
  decided_at: number | null;
}

export interface IdeaSyncResult {
  /** Ideas created by this refresh. */
  added: IdeaRecord[];
  /** Undecided ideas removed because their source no longer qualifies. */
  retired: string[];
}

export interface IdeaListOptions {
  status?: IdeaStatus | IdeaStatus[];
  limit?: number;
}

export class IdeaStore {
  private readonly db: Database.Database;

  constructor(options: { dbFile: string }) {
    mkdirSync(dirname(options.dbFile), { recursive: true });
    this.db = new DatabaseCtor(options.dbFile);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  /**
   * Bring the undecided ideas in line with what the rules offer now.
   * `candidates` are every qualifying source, newest first within a kind.
   *
   *  - A source a person already decided (accepted or dismissed) is set
   *    aside first: it is never offered again and takes no slot.
   *  - A `new` idea whose source still qualifies stays, whatever its rank,
   *    so a card never disappears just because newer ones arrived.
   *  - Free slots, up to `IDEAS_PER_KIND_MAX` waiting cards per kind, go to
   *    sources that have never had an idea, newest first.
   *  - A `new` idea whose source no longer qualifies (the task was run
   *    again, the goal finished) is removed.
   */
  sync(candidates: readonly IdeaCandidate[], now: number = Date.now()): IdeaSyncResult {
    const insert = this.db.prepare(
      `INSERT INTO ideas (id, kind, source_key, title, reason, evidence_json, prompt,
         session_id, status, task_id, created_at, updated_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', NULL, ?, ?, NULL)
       ON CONFLICT(source_key) DO NOTHING`,
    );
    const added: IdeaRecord[] = [];
    const retired: string[] = [];
    this.db.transaction(() => {
      const known = new Map(
        (this.db.prepare(`SELECT source_key, status FROM ideas`).all() as Array<{
          source_key: string;
          status: string;
        }>).map((r) => [r.source_key, r.status]),
      );
      const qualifying = new Set<string>();
      const waiting = new Map<string, number>();
      const fresh: IdeaCandidate[] = [];
      for (const c of candidates) {
        if (qualifying.has(c.sourceKey)) continue;
        qualifying.add(c.sourceKey);
        const status = known.get(c.sourceKey);
        if (status === undefined) fresh.push(c);
        else if (status === "new") waiting.set(c.kind, (waiting.get(c.kind) ?? 0) + 1);
        // accepted / dismissed: decided, takes no slot
      }
      for (const c of fresh) {
        const count = waiting.get(c.kind) ?? 0;
        if (count >= IDEAS_PER_KIND_MAX) continue;
        const id = randomUUID();
        const info = insert.run(
          id, c.kind, c.sourceKey, c.title, c.reason, JSON.stringify(c.evidence),
          c.prompt, c.sessionId, now, now,
        );
        if (info.changes === 1) {
          waiting.set(c.kind, count + 1);
          const row = this.get(id);
          if (row) added.push(row);
        }
      }
      const undecided = this.db
        .prepare(`SELECT id, source_key FROM ideas WHERE status = 'new'`)
        .all() as Array<{ id: string; source_key: string }>;
      const del = this.db.prepare(`DELETE FROM ideas WHERE id = ? AND status = 'new'`);
      for (const row of undecided) {
        if (qualifying.has(row.source_key)) continue;
        if (del.run(row.id).changes === 1) retired.push(row.id);
      }
    })();
    return { added, retired };
  }

  get(id: string): IdeaRecord | null {
    const row = this.db.prepare(`SELECT * FROM ideas WHERE id = ?`).get(id) as IdeaRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** Newest first. */
  list(options: IdeaListOptions = {}): IdeaRecord[] {
    const statuses = options.status === undefined
      ? null
      : Array.isArray(options.status) ? options.status : [options.status];
    const limit = options.limit ?? 100;
    const rows = (statuses === null || statuses.length === 0
      ? this.db.prepare(`SELECT * FROM ideas ORDER BY created_at DESC, id ASC LIMIT ?`).all(limit)
      : this.db
          .prepare(
            `SELECT * FROM ideas WHERE status IN (${statuses.map(() => "?").join(",")})
             ORDER BY created_at DESC, id ASC LIMIT ?`,
          )
          .all(...statuses, limit)) as IdeaRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Take a `new` idea for acceptance (compare-and-swap on the status):
   * it becomes `accepted` with no task yet, so a second accept of the
   * same card fails here instead of filing a second task. The caller
   * then creates the task and calls `attachTask`, or `release` when the
   * task could not be created. `null` for an unknown id.
   */
  claimForAccept(id: string, prompt: string | null, now: number = Date.now()): IdeaRecord | null {
    return this.decide(id, "accepted", prompt, now);
  }

  attachTask(id: string, taskId: string, now: number = Date.now()): IdeaRecord | null {
    this.db
      .prepare(`UPDATE ideas SET task_id = ?, updated_at = ? WHERE id = ? AND status = 'accepted'`)
      .run(taskId, now, id);
    return this.get(id);
  }

  /** Undo `claimForAccept` when the task was refused: the card is `new` again. */
  release(id: string, previousPrompt: string, now: number = Date.now()): void {
    this.db
      .prepare(
        `UPDATE ideas SET status = 'new', prompt = ?, decided_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'accepted' AND task_id IS NULL`,
      )
      .run(previousPrompt, now, id);
  }

  /**
   * Dismiss a `new` idea. Dismissing an already dismissed one returns it
   * unchanged; an accepted one throws `IdeaStateError`. `null` for an
   * unknown id.
   */
  dismiss(id: string, now: number = Date.now()): IdeaRecord | null {
    const current = this.get(id);
    if (current?.status === "dismissed") return current;
    return this.decide(id, "dismissed", null, now);
  }

  close(): void {
    this.db.close();
  }

  private decide(
    id: string,
    to: "accepted" | "dismissed",
    prompt: string | null,
    now: number,
  ): IdeaRecord | null {
    const info = this.db
      .prepare(
        `UPDATE ideas SET status = ?, prompt = COALESCE(?, prompt), decided_at = ?, updated_at = ?
         WHERE id = ? AND status = 'new'`,
      )
      .run(to, prompt, now, now, id);
    const after = this.get(id);
    if (after === null) return null;
    if (info.changes !== 1) throw new IdeaStateError(id, after.status, to);
    return after;
  }
}

function rowToRecord(row: IdeaRow): IdeaRecord {
  return {
    id: row.id,
    kind: row.kind as IdeaKind,
    sourceKey: row.source_key,
    title: row.title,
    reason: row.reason,
    evidence: parseEvidence(row.evidence_json, row.source_key),
    prompt: row.prompt,
    sessionId: row.session_id,
    status: IDEA_STATUSES.includes(row.status as IdeaStatus) ? (row.status as IdeaStatus) : "dismissed",
    taskId: row.task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
  };
}

function parseEvidence(raw: string, sourceKey: string): IdeaEvidence {
  try {
    const v = JSON.parse(raw) as Partial<IdeaEvidence>;
    if ((v.source === "task" || v.source === "goal") && typeof v.ref === "string") {
      return {
        source: v.source,
        ref: v.ref,
        excerpt: typeof v.excerpt === "string" ? v.excerpt : "",
        at: typeof v.at === "number" ? v.at : null,
      };
    }
  } catch {
    // fall through: a row that does not parse still shows its card
  }
  return { source: sourceKey.startsWith("goal:") ? "goal" : "task", ref: "", excerpt: "", at: null };
}
