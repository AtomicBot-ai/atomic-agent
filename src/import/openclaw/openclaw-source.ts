import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../../native/load-better-sqlite3.js";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  isoToMs,
  parseLogLine,
  projectLogMessage,
  splitLogLines,
} from "./openclaw-log-events.js";

/**
 * Read-only access to a `~/.openclaw` state directory. This is the **only**
 * file in the OpenClaw import feature that touches OpenClaw's physical
 * layout (event-sourced JSONL session logs + the `state/openclaw.sqlite`
 * cron table). Everything downstream operates on the neutral types
 * exported here so the mappers never depend on OpenClaw's on-disk shape.
 *
 * Layout (one subtree per agent; `main` is the default):
 *  - `agents/<agent>/sessions/<id>.jsonl`  — event-sourced transcript.
 *  - `agents/<agent>/sessions/<id>.trajectory.jsonl` — raw provider trace
 *    (skipped — not a user-visible transcript).
 *  - `state/openclaw.sqlite` table `cron_jobs`.
 */
export class OpenclawSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenclawSourceError";
  }
}

/**
 * OpenClaw's default agent. Its sessions import under the bare
 * `openclaw:<id>`; every other agent's under `openclaw:<agent>:<id>`.
 */
export const OPENCLAW_DEFAULT_AGENT = "main";

/** Lightweight session header read from the leading `session` event. */
export interface OpenclawSessionMeta {
  id: string;
  /** The agent whose `sessions/` dir holds the log. */
  agent: string;
  /** Absolute path to the `<id>.jsonl` runtime log. */
  file: string;
  cwd: string | null;
  /** Provider model id from the first `model_change` event, when present. */
  model: string | null;
  /** `session` event timestamp in integer milliseconds. */
  startedAtMs: number;
}

/** A single content block inside an OpenClaw message. */
export type OpenclawBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "toolCall";
      id: string | null;
      name: string;
      args: Record<string, unknown>;
    };

/** A projected OpenClaw message event (the `message` envelope unwrapped). */
export interface OpenclawMessage {
  role: "user" | "assistant" | "toolResult";
  blocks: OpenclawBlock[];
  /** `toolCallId` on `toolResult` rows. */
  toolCallId: string | null;
  /** `toolName` on `toolResult` rows. */
  toolName: string | null;
  /** True when a `toolResult` row reported an error. */
  isError: boolean;
  /** Message timestamp in integer milliseconds. */
  atMs: number;
}

/**
 * An OpenClaw cron job (subset of the rich `cron_jobs` schema we map).
 * Schedule is exposed field-by-field; the mapper decides the kind from
 * whichever of `scheduleExpr` / `everyMs` / `at` is populated.
 */
export interface OpenclawCronJob {
  id: string;
  name: string | null;
  prompt: string;
  enabled: boolean;
  scheduleKind: string;
  scheduleExpr: string | null;
  scheduleTz: string | null;
  everyMs: number | null;
  /** ISO timestamp for one-shot (`at`) schedules. */
  at: string | null;
}

interface CronRow {
  job_id: string;
  name: string | null;
  enabled: number;
  schedule_kind: string;
  schedule_expr: string | null;
  schedule_tz: string | null;
  every_ms: number | null;
  at: string | null;
  payload_message: string | null;
  agent_id: string | null;
}

export class OpenclawSource {
  private db: Database.Database | null = null;

  constructor(
    private readonly sourceDir: string,
    private readonly agent: string = OPENCLAW_DEFAULT_AGENT,
  ) {}

  /** The agent this instance reads sessions and cron jobs for. */
  agentName(): string {
    return this.agent;
  }

  agentsDir(): string {
    return join(this.sourceDir, "agents");
  }

  sessionsDir(): string {
    return join(this.agentsDir(), this.agent, "sessions");
  }

  /**
   * Every agent on disk that has a `sessions/` dir, sorted by name. The
   * TUI and the first-run flow import all of them; the CLI's `--agent`
   * narrows to one.
   */
  listAgents(): string[] {
    const root = this.agentsDir();
    if (!existsSync(root)) return [];
    const agents: string[] = [];
    for (const entry of readdirSync(root).sort()) {
      const sessions = join(root, entry, "sessions");
      try {
        if (statSync(sessions).isDirectory()) agents.push(entry);
      } catch {
        continue;
      }
    }
    return agents;
  }

  /** A sibling reader over the same state dir for another agent. */
  forAgent(agent: string): OpenclawSource {
    return new OpenclawSource(this.sourceDir, agent);
  }

  stateDbPath(): string {
    return join(this.sourceDir, "state", "openclaw.sqlite");
  }

  hasSessions(): boolean {
    return existsSync(this.sessionsDir());
  }

  hasStateDb(): boolean {
    return existsSync(this.stateDbPath());
  }

  /**
   * List session headers for the configured agent, newest-first by the
   * `session` event timestamp (id as the tiebreak), so a `limit` keeps
   * the most recent N like every other source. Only `<id>.jsonl` runtime
   * logs are considered; `.trajectory.jsonl`
   * (raw provider trace) and `.trajectory-path.json` pointers are skipped.
   * A file without a parseable `session` event is dropped.
   */
  listSessions(): OpenclawSessionMeta[] {
    const dir = this.sessionsDir();
    if (!existsSync(dir)) return [];
    const metas: OpenclawSessionMeta[] = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".jsonl")) continue;
      if (entry.endsWith(".trajectory.jsonl")) continue;
      const file = join(dir, entry);
      const meta = this.readSessionMeta(file);
      if (meta) metas.push(meta);
    }
    metas.sort(
      (a, b) =>
        b.startedAtMs - a.startedAtMs ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return metas;
  }

  /** Parse the leading `session` + first `model_change` events of a log. */
  private readSessionMeta(file: string): OpenclawSessionMeta | null {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    let id: string | null = null;
    let cwd: string | null = null;
    let model: string | null = null;
    let startedAtMs = 0;
    for (const line of splitLogLines(text)) {
      const event = parseLogLine(line);
      if (!event) continue;
      if (event.type === "session") {
        id = typeof event.id === "string" ? event.id : null;
        cwd = typeof event.cwd === "string" ? event.cwd : null;
        startedAtMs = isoToMs(event.timestamp) ?? 0;
      } else if (event.type === "model_change" && model === null) {
        model = typeof event.modelId === "string" ? event.modelId : null;
      }
      if (id !== null && model !== null) break;
    }
    if (id === null) return null;
    return { id, agent: this.agent, file, cwd, model, startedAtMs };
  }

  /** Parse every `message` event of a session log into neutral messages. */
  readMessages(meta: OpenclawSessionMeta): OpenclawMessage[] {
    let text: string;
    try {
      text = readFileSync(meta.file, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new OpenclawSourceError(`failed to read ${meta.file}: ${message}`);
    }
    const messages: OpenclawMessage[] = [];
    for (const line of splitLogLines(text)) {
      const event = parseLogLine(line);
      if (!event || event.type !== "message") continue;
      const projected = projectLogMessage(event);
      if (projected) messages.push(projected);
    }
    return messages;
  }

  /** Open the SQLite database read-only, lazily and once. */
  private openDb(): Database.Database {
    if (this.db) return this.db;
    const path = this.stateDbPath();
    if (!existsSync(path)) {
      throw new OpenclawSourceError(`OpenClaw state db not found: ${path}`);
    }
    this.db = new DatabaseCtor(path, { readonly: true, fileMustExist: true });
    return this.db;
  }

  /**
   * Read cron jobs scoped to the configured agent (plus global rows with a
   * NULL `agent_id`). Returns an empty list when the table is absent.
   */
  readCronJobs(): OpenclawCronJob[] {
    const db = this.openDb();
    const tableExists = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cron_jobs'`,
      )
      .get();
    if (!tableExists) return [];
    const rows = db
      .prepare(
        `SELECT job_id, name, enabled, schedule_kind, schedule_expr,
                schedule_tz, every_ms, at, payload_message, agent_id
           FROM cron_jobs
          WHERE agent_id IS NULL OR agent_id = ?
          ORDER BY sort_order ASC, job_id ASC`,
      )
      .all(this.agent) as CronRow[];
    return rows.map((row) => ({
      id: row.job_id,
      name: row.name,
      prompt: row.payload_message ?? "",
      enabled: row.enabled === 1,
      scheduleKind: row.schedule_kind,
      scheduleExpr: row.schedule_expr,
      scheduleTz: row.schedule_tz,
      everyMs: typeof row.every_ms === "number" ? row.every_ms : null,
      at: row.at,
    }));
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
