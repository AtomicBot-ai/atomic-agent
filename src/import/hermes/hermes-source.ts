import type Database from "better-sqlite3";
import { Database as DatabaseCtor } from "../../native/load-better-sqlite3.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Read-only access to a `~/.hermes` state directory. This is the **only**
 * file in the import feature that touches Hermes' own storage (SQLite +
 * JSON + dotenv). Everything downstream operates on the neutral types
 * exported here so the mappers never depend on Hermes' physical layout.
 */
export class HermesSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesSourceError";
  }
}

/** A Hermes chat session row (subset of columns we map). */
export interface HermesSession {
  id: string;
  /** Working directory the session ran in, when recorded. */
  cwd: string | null;
  title: string | null;
  model: string | null;
  /** `started_at` REAL seconds since the Unix epoch. */
  startedAtSeconds: number;
  archived: boolean;
}

/** A single Hermes message row in a session transcript. */
export interface HermesMessage {
  id: number;
  sessionId: string;
  role: string;
  content: string | null;
  /** Raw `tool_calls` JSON string (assistant rows that called tools). */
  toolCalls: string | null;
  /** Tool name on `role = "tool"` rows. */
  toolName: string | null;
  /** `timestamp` REAL seconds since the Unix epoch. */
  timestampSeconds: number;
  /** `reasoning_content` with a fallback to the legacy `reasoning` column. */
  reasoning: string | null;
}

/**
 * Hermes cron schedule. Field names mirror `cron/jobs.py parse_schedule`:
 * `once` carries `run_at` (ISO), `interval` carries `minutes`, `cron`
 * carries `expr`.
 */
export interface HermesSchedule {
  kind: string;
  run_at?: string;
  minutes?: number;
  expr?: string;
}

/** A Hermes cron job (subset of fields we map). */
export interface HermesCronJob {
  id: string;
  name: string | null;
  prompt: string;
  enabled: boolean;
  schedule: HermesSchedule;
}

interface SessionRow {
  id: string;
  cwd: string | null;
  title: string | null;
  model: string | null;
  started_at: number;
  archived: number;
}

interface MessageRow {
  id: number;
  role: string;
  content: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  timestamp: number;
  reasoning: string | null;
}

export class HermesSource {
  private db: Database.Database | null = null;

  constructor(private readonly sourceDir: string) {}

  stateDbPath(): string {
    return join(this.sourceDir, "state.db");
  }

  cronJobsPath(): string {
    return join(this.sourceDir, "cron", "jobs.json");
  }

  envPath(): string {
    return join(this.sourceDir, ".env");
  }

  hasStateDb(): boolean {
    return existsSync(this.stateDbPath());
  }

  hasCronJobs(): boolean {
    return existsSync(this.cronJobsPath());
  }

  hasEnvFile(): boolean {
    return existsSync(this.envPath());
  }

  /** Open the SQLite database read-only, lazily and once. */
  private openDb(): Database.Database {
    if (this.db) return this.db;
    const path = this.stateDbPath();
    if (!existsSync(path)) {
      throw new HermesSourceError(`Hermes state.db not found: ${path}`);
    }
    this.db = new DatabaseCtor(path, { readonly: true, fileMustExist: true });
    return this.db;
  }

  readSessions(): HermesSession[] {
    const db = this.openDb();
    const rows = db
      .prepare(
        `SELECT id, cwd, title, model, started_at, archived
           FROM sessions
          ORDER BY started_at ASC, id ASC`,
      )
      .all() as SessionRow[];
    return rows.map((row) => ({
      id: row.id,
      cwd: row.cwd,
      title: row.title,
      model: row.model,
      startedAtSeconds: row.started_at,
      archived: row.archived === 1,
    }));
  }

  readMessages(sessionId: string): HermesMessage[] {
    const db = this.openDb();
    const rows = db
      .prepare(
        `SELECT id, role, content, tool_calls, tool_name, timestamp,
                COALESCE(reasoning_content, reasoning) AS reasoning
           FROM messages
          WHERE session_id = ?
          ORDER BY timestamp ASC, id ASC`,
      )
      .all(sessionId) as MessageRow[];
    return rows.map((row) => ({
      id: row.id,
      sessionId,
      role: row.role,
      content: row.content,
      toolCalls: row.tool_calls,
      toolName: row.tool_name,
      timestampSeconds: row.timestamp,
      reasoning: row.reasoning,
    }));
  }

  /**
   * Read and parse `cron/jobs.json`. Returns an empty list when the file
   * is missing. Malformed JSON throws a `HermesSourceError`.
   */
  readCronJobs(): HermesCronJob[] {
    const path = this.cronJobsPath();
    if (!existsSync(path)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HermesSourceError(`failed to parse ${path}: ${message}`);
    }
    const jobs =
      parsed && typeof parsed === "object" && Array.isArray((parsed as { jobs?: unknown }).jobs)
        ? ((parsed as { jobs: unknown[] }).jobs)
        : [];
    const result: HermesCronJob[] = [];
    for (const raw of jobs) {
      if (!raw || typeof raw !== "object") continue;
      const job = raw as Record<string, unknown>;
      const id = typeof job.id === "string" ? job.id : null;
      const prompt = typeof job.prompt === "string" ? job.prompt : null;
      if (!id || !prompt) continue;
      const scheduleRaw =
        job.schedule && typeof job.schedule === "object"
          ? (job.schedule as Record<string, unknown>)
          : {};
      const schedule: HermesSchedule = {
        kind: typeof scheduleRaw.kind === "string" ? scheduleRaw.kind : "",
        ...(typeof scheduleRaw.run_at === "string"
          ? { run_at: scheduleRaw.run_at }
          : {}),
        ...(typeof scheduleRaw.minutes === "number"
          ? { minutes: scheduleRaw.minutes }
          : {}),
        ...(typeof scheduleRaw.expr === "string"
          ? { expr: scheduleRaw.expr }
          : {}),
      };
      result.push({
        id,
        name: typeof job.name === "string" ? job.name : null,
        prompt,
        enabled: job.enabled !== false,
        schedule,
      });
    }
    return result;
  }

  /**
   * Read `<sourceDir>/.env` and return only the keys present in
   * `allowlist` that have a non-empty value. The parser mirrors
   * `loadDotenvFromStateDir`: `KEY=VALUE` per line, surrounding quotes
   * stripped, `#` comments and blank lines ignored, no interpolation.
   */
  readEnvKeys(allowlist: readonly string[]): Map<string, string> {
    const result = new Map<string, string>();
    const path = this.envPath();
    if (!existsSync(path)) return result;
    const allowed = new Set(allowlist);
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!allowed.has(key)) continue;
      const value = stripQuotes(trimmed.slice(eq + 1).trim());
      if (value.length === 0) continue;
      result.set(key, value);
    }
    return result;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/** Strip a single matching pair of surrounding single or double quotes. */
function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
