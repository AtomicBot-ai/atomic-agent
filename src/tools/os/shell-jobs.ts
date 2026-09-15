import type { CommandJob } from "../../sandbox/command-job.js";
import type { ShellCommandFacts } from "./shell-result.js";

/**
 * The jobs `os.shell.run` detached instead of killing (F47), per
 * session. A command still running when the operator's default timeout
 * elapses keeps running here, in its own process group, with its output
 * captured; the model reaches it by id through the `wait` / `kill` /
 * `jobs` forms of the same tool.
 *
 * Ownership: a job dies when its turn ends unless the call that started
 * it (or a later `wait`) carried `keep: true`; every job dies when its
 * session ends, at the process's shutdown, and at the absolute ceiling
 * `tools.shell.jobMaxMs` counted from its start. At most
 * `tools.shell.maxJobs` run per session: the next detach stops the
 * oldest un-kept one (the oldest kept one when all are kept) and the
 * result says so. The bootstrap owns the one registry and calls
 * `endTurn` / `endSession` / `endAll` from the turn, session and
 * shutdown paths; a tool built without one gets a private registry
 * whose jobs die at the ceiling only.
 */

export const DEFAULT_SHELL_JOB_MAX_MS = 3_600_000;
export const DEFAULT_SHELL_MAX_JOBS = 3;
/** Finished, uncollected records a session may hold before the oldest goes. */
const MAX_FINISHED_RECORDS = 20;

export type ShellJobState = "running" | "exited" | "killed";

export type ShellJobStopReason =
  | "kill"
  | "turn_end"
  | "session_end"
  | "evicted"
  | "ceiling"
  | "shutdown";

export interface ShellJobRecord {
  /** Per session, from 1 — what the model quotes back. */
  readonly id: number;
  readonly sessionId: string;
  /** What the command was, so a collected result reads like a fresh one. */
  readonly facts: ShellCommandFacts;
  readonly job: CommandJob;
  keep: boolean;
  /** `killed` is set when the stop is sent, before the process is gone. */
  state: ShellJobState;
  stopReason: ShellJobStopReason | null;
}

export interface ShellJobRegistryOptions {
  /** Absolute ceiling per job, from its start. Default one hour. */
  jobMaxMs?: number;
  /** Running jobs per session. Default 3. */
  maxJobs?: number;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export class ShellJobRegistry {
  readonly jobMaxMs: number;
  readonly maxJobs: number;
  private readonly bySession = new Map<string, ShellJobRecord[]>();
  private readonly nextIds = new Map<string, number>();
  private readonly ceilings = new Map<
    ShellJobRecord,
    ReturnType<typeof setTimeout>
  >();

  constructor(options: ShellJobRegistryOptions = {}) {
    this.jobMaxMs = positiveOr(options.jobMaxMs, DEFAULT_SHELL_JOB_MAX_MS);
    this.maxJobs = positiveOr(options.maxJobs, DEFAULT_SHELL_MAX_JOBS);
  }

  /**
   * Take a job the default timeout detached. When the session already
   * runs `maxJobs`, the oldest un-kept running job (the oldest kept one
   * when all are kept) is stopped first and returned as `evicted`.
   */
  register(
    sessionId: string,
    job: CommandJob,
    facts: ShellCommandFacts,
    keep: boolean,
  ): { record: ShellJobRecord; evicted: ShellJobRecord | null } {
    const records = this.records(sessionId);
    let evicted: ShellJobRecord | null = null;
    const running = records.filter((r) => r.state === "running");
    if (running.length >= this.maxJobs) {
      // Records are in start order, so the first match is the oldest.
      evicted = running.find((r) => !r.keep) ?? running[0]!;
      this.stop(evicted, "evicted");
    }
    const id = this.nextIds.get(sessionId) ?? 1;
    this.nextIds.set(sessionId, id + 1);
    const record: ShellJobRecord = {
      id,
      sessionId,
      facts,
      job,
      keep,
      state: "running",
      stopReason: null,
    };
    records.push(record);
    const settle = () => {
      if (record.state === "running") record.state = "exited";
      this.clearCeiling(record);
    };
    job.exit.then(settle, settle);
    // The ceiling counts from the spawn, not from the detach.
    const remaining = Math.max(0, this.jobMaxMs - (Date.now() - job.startedAt));
    const timer = setTimeout(() => this.stop(record, "ceiling"), remaining);
    // The registry must never be what keeps the process alive.
    timer.unref();
    this.ceilings.set(record, timer);
    this.trimFinished(records);
    return { record, evicted };
  }

  /** A job of this session only — another session's id is unknown here. */
  get(sessionId: string, id: number): ShellJobRecord | undefined {
    return this.bySession.get(sessionId)?.find((r) => r.id === id);
  }

  /** This session's records, oldest first; finished ones until collected. */
  list(sessionId: string): ShellJobRecord[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  markKeep(record: ShellJobRecord): void {
    record.keep = true;
  }

  /**
   * Stop a running job politely (`SIGTERM`, then `SIGKILL` after the
   * grace) and mark why. `false` when it was not running.
   */
  stop(record: ShellJobRecord, reason: ShellJobStopReason): boolean {
    if (record.state !== "running") return false;
    record.state = "killed";
    record.stopReason = reason;
    this.clearCeiling(record);
    record.job.stop();
    return true;
  }

  /** Forget a record whose result was reported (a `wait` or a `kill` collected it). */
  drop(record: ShellJobRecord): void {
    this.clearCeiling(record);
    const records = this.bySession.get(record.sessionId);
    if (!records) return;
    const index = records.indexOf(record);
    if (index >= 0) records.splice(index, 1);
    if (records.length === 0) this.bySession.delete(record.sessionId);
  }

  /**
   * The turn ended: every un-kept job of the session is stopped and
   * forgotten, collected or not. Kept ones stay, running or exited,
   * for a later turn's `wait`. Returns the jobs that were stopped.
   */
  endTurn(sessionId: string): ShellJobRecord[] {
    return this.endRecords(this.list(sessionId).filter((r) => !r.keep), "turn_end");
  }

  /** The session ended: every job of it, kept or not. */
  endSession(sessionId: string): ShellJobRecord[] {
    return this.endRecords(this.list(sessionId), "session_end");
  }

  /** The process is shutting down: every job of every session. */
  endAll(): ShellJobRecord[] {
    const all = [...this.bySession.keys()].flatMap((id) => this.list(id));
    return this.endRecords(all, "shutdown");
  }

  private endRecords(
    records: ShellJobRecord[],
    reason: ShellJobStopReason,
  ): ShellJobRecord[] {
    const stopped: ShellJobRecord[] = [];
    for (const record of records) {
      if (this.stop(record, reason)) stopped.push(record);
      this.drop(record);
    }
    return stopped;
  }

  private records(sessionId: string): ShellJobRecord[] {
    let records = this.bySession.get(sessionId);
    if (!records) {
      records = [];
      this.bySession.set(sessionId, records);
    }
    return records;
  }

  private clearCeiling(record: ShellJobRecord): void {
    const timer = this.ceilings.get(record);
    if (timer) clearTimeout(timer);
    this.ceilings.delete(record);
  }

  /** Bound the memory a session's uncollected output can hold. */
  private trimFinished(records: ShellJobRecord[]): void {
    let finished = records.filter((r) => r.state !== "running");
    while (finished.length > MAX_FINISHED_RECORDS) {
      this.drop(finished[0]!);
      finished = finished.slice(1);
    }
  }
}
