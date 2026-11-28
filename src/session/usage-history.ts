import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import { spendDayKey } from "./daily-spend.js";
import { foldCompletion, foldToolCall } from "./usage-history-fold.js";
import { pruneUsageHistory, readUsageHistory, readUsageHistoryForWrite } from "./usage-history-parse.js";
import type { UsageHistoryFile, UsageHistoryInput, UsageProjectRef } from "./usage-history-types.js";
import { noProject, usageProjectRef, usageSessionKey } from "./usage-project-key.js";

export * from "./usage-history-types.js";
export { readUsageHistory, readUsageHistoryForWrite } from "./usage-history-parse.js";

/**
 * Tokens and spend per day, across every session (ATO-2352): the data
 * behind `atomic-agent usage`, the TUI's `/usage` and `GET /api/usage`.
 * `daily-spend.json` keeps only today's dollars for the ceiling; this
 * file keeps the history, split by day, by model and by how the link
 * bills (a local server, a subscription plan, or a per-token cloud
 * link), and since ATO-2442 also by project folder, by tool, and the
 * sessions that made a call each day.
 *
 * Durable and outside the model, in the state directory, so it survives
 * a restart and is shared by the terminal and the desktop app. Every
 * write re-reads the file first, like `DailySpendStore`, so two
 * processes add to one history. See `usage-history-types.ts` for what
 * is stored (counts, ids and hashes; no prompt, no reply, no path).
 */
export interface UsageHistoryStoreOptions {
  path: string;
  /** UTC hour the day starts at (`llm.costTracking.dailyResetHourUtc`); read on every call. */
  resetHourUtc?: () => number;
  now?: () => number;
  /**
   * The working folder of a session, for the per-project split
   * (ATO-2442). Remembered once found; a throw or an unknown session
   * files the call under "(no project)" and is asked again next time.
   */
  workingDirOf?: (sessionId: string) => string | null | undefined;
}

/** Sessions whose project is remembered; the oldest is forgotten first. */
const PROJECT_CACHE_MAX = 256;

export class UsageHistoryStore {
  private readonly path: string;
  private readonly resetHourUtc: () => number;
  private readonly now: () => number;
  private readonly workingDirOf: ((sessionId: string) => string | null | undefined) | undefined;
  private readonly projects = new Map<string, UsageProjectRef>();

  constructor(options: UsageHistoryStoreOptions) {
    this.path = options.path;
    this.resetHourUtc = options.resetHourUtc ?? (() => 0);
    this.now = options.now ?? Date.now;
    this.workingDirOf = options.workingDirOf;
  }

  /** The day key `record` would write to right now. */
  currentDay(): string {
    return spendDayKey(this.now(), this.resetHourUtc());
  }

  /** The whole history, read from disk (another process may have added to it). */
  read(): UsageHistoryFile {
    return readUsageHistory(this.path);
  }

  /** Fold one completion in. A completion with no tokens changes nothing. */
  record(input: UsageHistoryInput): void {
    const sessionId = input.sessionId;
    this.update((file, day) =>
      foldCompletion(file, {
        day,
        input,
        project: sessionId ? this.projectOf(sessionId) : noProject(),
        ...(sessionId ? { sessionKey: usageSessionKey(sessionId) } : {}),
      }),
    );
  }

  /** Count one finished tool call (ATO-2442); `failed` when it ended in an error. */
  recordTool(tool: string, failed: boolean): void {
    this.update((file, day) => foldToolCall(file, day, tool, failed));
  }

  private update(fold: (file: UsageHistoryFile, day: string) => UsageHistoryFile | null): void {
    // Only a missing file starts a new history. A file that could not be
    // read (EACCES, EBUSY, the other process mid-rename), could not be
    // parsed, or was written by a newer version is left alone: this call
    // goes uncounted rather than wiping every day on record.
    const file = readUsageHistoryForWrite(this.path);
    if (file === null) return;
    const next = fold(file, this.currentDay());
    if (next === null) return;
    this.write(pruneUsageHistory(next));
  }

  private projectOf(sessionId: string): UsageProjectRef {
    const known = this.projects.get(sessionId);
    if (known) return known;
    let dir: string | null | undefined;
    try {
      dir = this.workingDirOf?.(sessionId);
    } catch {
      dir = undefined;
    }
    const ref = usageProjectRef(dir);
    // Not remembered when unknown: a session saved after its first call is found on the next.
    if (ref.key === noProject().key) return ref;
    if (this.projects.size >= PROJECT_CACHE_MAX) {
      const oldest = this.projects.keys().next().value;
      if (oldest !== undefined) this.projects.delete(oldest);
    }
    this.projects.set(sessionId, ref);
    return ref;
  }

  private write(file: UsageHistoryFile): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${randomUUID()}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch {
      // A read-only state dir must not fail a completion.
    }
  }
}
