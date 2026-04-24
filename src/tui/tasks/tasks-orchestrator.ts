import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { TaskRecord, TaskSchedule } from "../../tasks/task-types.js";
import type { TuiEventBus } from "../tui-app.js";
import { toTaskSummaryRows } from "./tasks-summary.js";
import type {
  TaskCreateKind,
  TaskFiringEntry,
} from "./tasks-panel-state.js";

export interface TasksOrchestratorDeps {
  /** Current live session id, or `null` when the user has not typed anything yet. */
  getCurrentSessionId(): string | null;
  /** Swap the chat transcript to `sessionId` — used by "open session". */
  switchSession(sessionId: string): void;
}

export interface TasksOrchestratorOptions {
  /** Refresh cadence for the task list. Defaults to 5_000 ms. */
  refreshIntervalMs?: number;
  /** Hard cap on rows fetched from `TaskStore.list`. */
  listLimit?: number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 5_000;
const DEFAULT_LIST_LIMIT = 200;

/**
 * Bridge between the Tasks tab state slice and `runtime.taskStore /
 * runtime.taskRunner`. The reducer never touches SQLite; every
 * side-effecting operation enters here first and emits actions on the
 * bus so the reducer (and therefore the UI) stays consistent.
 *
 * Firing entries for the detail view are computed locally by
 * diff-observing task records between refresh ticks — when a record
 * transitions `running -> { completed | failed | blocked | cancelled }`
 * (or a recurring task's `attempts` climbs past what we saw last), we
 * emit a synthetic `TaskFiringEntry` into the panel state.
 */
export class TasksOrchestrator {
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly lastSeen = new Map<string, TaskRecord>();
  private readonly refreshIntervalMs: number;
  private readonly listLimit: number;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
    private readonly deps: TasksOrchestratorDeps,
    options: TasksOrchestratorOptions = {},
  ) {
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.listLimit = options.listLimit ?? DEFAULT_LIST_LIMIT;
  }

  /** Start the periodic refresh loop. Idempotent. */
  startAutoRefresh(): void {
    if (this.refreshTimer) return;
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), this.refreshIntervalMs);
  }

  shutdown(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** One-off refresh — dispatched on keypress `r` and after mutations. */
  refresh(): void {
    try {
      this.bus.emit({ type: "tasks_refresh_started" });
      const records = this.runtime.taskStore.list({ limit: this.listLimit });
      const rows = toTaskSummaryRows(records);
      this.bus.emit({ type: "tasks_refreshed", rows, at: Date.now() });
      this.observeFirings(records);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({ type: "tasks_refresh_failed", error: msg });
      this.bus.emit({
        type: "runtime_info",
        line: `tasks refresh failed: ${msg}`,
      });
    }
  }

  /** Open the detail view for `taskId` and re-seed the firings ring. */
  openDetail(taskId: string): void {
    this.bus.emit({ type: "tasks_detail_opened", taskId });
    const record = this.runtime.taskStore.get(taskId);
    if (record) {
      const entry = recordToFiring(record);
      if (entry) this.bus.emit({ type: "tasks_firing_observed", entry });
    }
  }

  /** Navigate the chat transcript to the task's session, if any. */
  openSession(taskId: string): void {
    const record = this.runtime.taskStore.get(taskId);
    if (!record) {
      this.bus.emit({
        type: "runtime_info",
        line: `task ${taskId} not found`,
      });
      return;
    }
    if (!record.sessionId) {
      this.bus.emit({
        type: "runtime_info",
        line: `task ${taskId} has no session yet (one-shot not picked up)`,
      });
      return;
    }
    this.deps.switchSession(record.sessionId);
  }

  /** Submit a new task via `TaskRunner.create`. */
  createTask(input: {
    schedule: TaskSchedule;
    message: string;
    kind: TaskCreateKind;
  }): void {
    this.bus.emit({ type: "tasks_create_submit_started" });
    try {
      const record = this.runtime.taskRunner.create({
        userMessage: input.message,
        origin: "tui",
        maxAttempts: 3,
        schedule: input.schedule,
        triggerSource: "user",
      });
      this.bus.emit({ type: "tasks_create_submit_settled" });
      this.bus.emit({
        type: "runtime_info",
        line: `task ${record.id} scheduled (${input.kind})`,
      });
      this.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({ type: "tasks_create_submit_settled", error: msg });
    }
  }

  /** Cancel `taskId` via `TaskStore.cancel`. Refresh afterwards. */
  cancelTask(taskId: string): void {
    try {
      const after = this.runtime.taskStore.cancel(taskId);
      let line: string;
      if (after === null) line = `task ${taskId} not found`;
      else if (after.status === "cancelled") line = `task ${taskId} cancelled`;
      else line = `task ${taskId} already ${after.status} (cannot cancel)`;
      this.bus.emit({ type: "runtime_info", line });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({
        type: "runtime_info",
        line: `cancel ${taskId} failed: ${msg}`,
      });
    } finally {
      this.bus.emit({ type: "tasks_cancel_confirm_closed" });
      this.refresh();
    }
  }

  /** Execute one attempt via `TaskRunner.runOne`. Refresh afterwards. */
  runNow(taskId: string): void {
    void (async () => {
      try {
        const result = await this.runtime.taskRunner.runOne(taskId);
        this.bus.emit({
          type: "runtime_info",
          line: result
            ? `task ${taskId} run complete (status=${result.status})`
            : `task ${taskId} skipped (already claimed or vanished)`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.bus.emit({
          type: "runtime_info",
          line: `run-now ${taskId} failed: ${msg}`,
        });
      } finally {
        this.refresh();
      }
    })();
  }

  /**
   * Diff the snapshot against the last-seen map and emit firing entries
   * for state transitions that represent a completed attempt. Keeps the
   * map bounded by only tracking tasks currently in the snapshot.
   */
  private observeFirings(records: readonly TaskRecord[]): void {
    const nextSeen = new Map<string, TaskRecord>();
    for (const record of records) {
      const previous = this.lastSeen.get(record.id);
      nextSeen.set(record.id, record);
      if (!previous) continue;
      const firedAgain =
        record.attempts > previous.attempts ||
        (previous.status === "running" && record.status !== "running") ||
        (record.recurring && record.completedAt !== previous.completedAt);
      if (!firedAgain) continue;
      const entry = recordToFiring(record);
      if (entry) this.bus.emit({ type: "tasks_firing_observed", entry });
    }
    this.lastSeen.clear();
    for (const [id, record] of nextSeen) this.lastSeen.set(id, record);
  }
}

function recordToFiring(record: TaskRecord): TaskFiringEntry | null {
  if (record.startedAt === null || record.sessionId === null) return null;
  const started = record.startedAt;
  const finished = record.completedAt;
  const reason = reasonFromStatus(record);
  return {
    id: `${record.id}:${started}`,
    taskId: record.id,
    sessionId: record.sessionId,
    startedAt: started,
    finishedAt: finished,
    reason,
    stepCount: record.attempts,
    durationMs: finished !== null ? Math.max(0, finished - started) : null,
  };
}

function reasonFromStatus(record: TaskRecord): TaskFiringEntry["reason"] {
  switch (record.status) {
    case "completed":
      return "finish";
    case "failed":
      return "error";
    case "blocked":
      return "error";
    case "cancelled":
      return "cancelled";
    case "running":
      return "pending";
    default:
      return null;
  }
}
