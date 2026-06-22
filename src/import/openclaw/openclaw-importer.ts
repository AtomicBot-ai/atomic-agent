import type { SessionStore } from "../../session/index.js";
import type { SessionState } from "../../session/session-state.js";
import type { TaskStore } from "../../tasks/index.js";
import {
  buildReport,
  type ImportItemResult,
  type ImportReport,
} from "../import-report.js";
import type { OpenclawSource } from "./openclaw-source.js";
import type { OpenclawOptionId } from "./import-options.js";
import { mapOpenclawCronJob } from "./map-cron.js";
import { mapOpenclawSession } from "./map-session.js";

export interface OpenclawImporterDeps {
  source: OpenclawSource;
  sessionStore: SessionStore;
  taskStore: TaskStore;
  /** Retry budget for created tasks (config.tasks.maxAttempts). */
  maxAttempts: number;
  /** Working dir applied to sessions whose OpenClaw `cwd` is null. */
  workingDirFallback: string;
  /** Injectable clock for deterministic past-detection. */
  now?: () => number;
}

export interface OpenclawRunOptions {
  /** Resolved option set (already gated by `resolveOpenclawOptions`). */
  options: readonly OpenclawOptionId[];
  /** When false, compute the report without writing anything. */
  execute: boolean;
  /** Overwrite differing destinations instead of flagging a conflict. */
  overwrite: boolean;
  /** Cap on the number of sessions processed. */
  limit?: number;
}

/**
 * Orchestrates a one-shot OpenClaw -> atomic-agent import. Each option is
 * processed independently and contributes `ImportItemResult`s to a single
 * `ImportReport`. Safe to re-run: unchanged destinations skip on match,
 * differing ones require `overwrite`.
 */
export class OpenclawImporter {
  constructor(private readonly deps: OpenclawImporterDeps) {}

  run(options: OpenclawRunOptions): ImportReport<OpenclawOptionId> {
    const items: ImportItemResult<OpenclawOptionId>[] = [];
    const selected = new Set(options.options);

    if (selected.has("sessions")) {
      this.importSessions(items, options);
    }
    if (selected.has("cron")) {
      this.importCron(items, options);
    }

    return buildReport(items, options.execute);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private importSessions(
    items: ImportItemResult<OpenclawOptionId>[],
    options: OpenclawRunOptions,
  ): void {
    if (!this.deps.source.hasSessions()) {
      items.push({
        kind: "sessions",
        status: "skipped",
        reason: `no sessions dir at ${this.deps.source.sessionsDir()}`,
      });
      return;
    }
    let metas = this.deps.source.listSessions();
    if (options.limit !== undefined && options.limit >= 0) {
      metas = metas.slice(0, options.limit);
    }
    for (const meta of metas) {
      const messages = this.deps.source.readMessages(meta);
      const mapped = mapOpenclawSession(
        meta,
        messages,
        this.deps.workingDirFallback,
      );
      items.push(this.reconcileSession(mapped, meta.id, options));
    }
  }

  private reconcileSession(
    mapped: SessionState,
    openclawId: string,
    options: OpenclawRunOptions,
  ): ImportItemResult<OpenclawOptionId> {
    const base: ImportItemResult<OpenclawOptionId> = {
      kind: "sessions",
      source: openclawId,
      destination: mapped.id,
      status: "migrated",
    };
    const existing = this.deps.sessionStore.load(mapped.id);
    if (!existing) {
      if (options.execute) this.deps.sessionStore.save(mapped);
      return base;
    }
    if (sessionsMatch(existing, mapped)) {
      return { ...base, status: "skipped", reason: "already matches" };
    }
    if (!options.overwrite) {
      return {
        ...base,
        status: "conflict",
        reason: "destination differs; use --overwrite",
      };
    }
    if (options.execute) this.deps.sessionStore.save(mapped);
    return { ...base, status: "migrated", reason: "overwritten" };
  }

  private importCron(
    items: ImportItemResult<OpenclawOptionId>[],
    options: OpenclawRunOptions,
  ): void {
    if (!this.deps.source.hasStateDb()) {
      items.push({
        kind: "cron",
        status: "skipped",
        reason: `no state db at ${this.deps.source.stateDbPath()}`,
      });
      return;
    }
    const jobs = this.deps.source.readCronJobs();
    const existingTasks = this.deps.taskStore.list({ limit: 10_000 });
    const now = this.now();

    for (const job of jobs) {
      const result = mapOpenclawCronJob(job, {
        maxAttempts: this.deps.maxAttempts,
        now,
      });
      if (result.kind === "skip") {
        items.push({
          kind: "cron",
          source: job.id,
          status: "skipped",
          reason: result.reason,
        });
        continue;
      }
      const duplicate = existingTasks.some(
        (task) =>
          task.userMessage === result.input.userMessage &&
          task.schedule?.kind === result.input.schedule?.kind,
      );
      if (duplicate && !options.overwrite) {
        items.push({
          kind: "cron",
          source: job.id,
          status: "skipped",
          reason: "task already exists",
        });
        continue;
      }
      let destination: string | undefined;
      if (options.execute) {
        const created = this.deps.taskStore.create(result.input, now);
        destination = created.id;
      }
      items.push({
        kind: "cron",
        source: job.id,
        ...(destination !== undefined ? { destination } : {}),
        status: "migrated",
        ...(duplicate ? { reason: "duplicate re-created (overwrite)" } : {}),
      });
    }
  }
}

/** Structural equality of two sessions' transcripts. */
function sessionsMatch(a: SessionState, b: SessionState): boolean {
  if (a.turns.length !== b.turns.length) return false;
  return JSON.stringify(a.turns) === JSON.stringify(b.turns);
}
