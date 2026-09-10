import type { SessionStore } from "../../session/index.js";
import type { SessionState } from "../../session/session-state.js";
import type { TaskStore } from "../../tasks/index.js";
import {
  buildReport,
  type ImportItemResult,
  type ImportReport,
} from "../import-report.js";
import { reconcileImportedSession } from "../reconcile-session.js";
import {
  OPENCLAW_DEFAULT_AGENT,
  type OpenclawSessionMeta,
  type OpenclawSource,
} from "./openclaw-source.js";
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
  /** Cap on the number of sessions processed (newest first, across agents). */
  limit?: number;
  /**
   * Agents whose sessions are imported. Unset means the source's own
   * agent (the CLI's `--agent`); pass `source.listAgents()` to take every
   * agent on disk, which is what the TUI and the first-run flow do.
   */
  agents?: readonly string[];
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
    const sources = this.sessionSources(options).filter((s) => s.hasSessions());
    if (sources.length === 0) {
      items.push({
        kind: "sessions",
        status: "skipped",
        reason: `no sessions dir at ${this.deps.source.sessionsDir()}`,
      });
      return;
    }
    // One newest-first list across every agent, so a limit keeps the
    // most recent N overall rather than N per agent.
    let metas = sources.flatMap((s) => s.listSessions());
    metas.sort(
      (a, b) =>
        b.startedAtMs - a.startedAtMs ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    if (options.limit !== undefined && options.limit >= 0) {
      metas = metas.slice(0, options.limit);
    }
    for (const meta of metas) {
      const messages = this.deps.source.readMessages(meta);
      if (messages.length === 0) {
        items.push({
          kind: "sessions",
          source: sourceLabel(meta),
          status: "skipped",
          reason: "no messages",
        });
        continue;
      }
      const mapped = mapOpenclawSession(
        meta,
        messages,
        this.deps.workingDirFallback,
      );
      items.push(this.reconcileSession(mapped, sourceLabel(meta), options));
    }
  }

  /** The source's own agent, or one sibling reader per requested agent. */
  private sessionSources(options: OpenclawRunOptions): OpenclawSource[] {
    const own = this.deps.source;
    if (!options.agents || options.agents.length === 0) return [own];
    return options.agents.map((agent) =>
      agent === own.agentName() ? own : own.forAgent(agent),
    );
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
    const outcome = reconcileImportedSession({
      existing: this.deps.sessionStore.load(mapped.id),
      mapped,
      execute: options.execute,
      overwrite: options.overwrite,
      save: (state) => this.deps.sessionStore.save(state),
    });
    return {
      ...base,
      status: outcome.status,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    };
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

/** Report id for a session: bare for the default agent, `<agent>:<id>` otherwise. */
function sourceLabel(meta: OpenclawSessionMeta): string {
  return meta.agent === OPENCLAW_DEFAULT_AGENT
    ? meta.id
    : `${meta.agent}:${meta.id}`;
}
