import type { AgentRuntime } from "../../runtime/bootstrap.js";
import {
  buildReport,
  IMPORT_AGENT_LABELS,
  ImportOptionError,
  type ImportItemResult,
  type ImportReport,
} from "../../import/index.js";
import type { OnboardingImportPlan } from "../onboarding/import-step.js";
import type { TuiEventBus } from "../tui-app.js";
import { buildImportRunner } from "./build-importer.js";
import {
  nothingSelectedNotice,
  resolveImportFormOptions,
} from "./import-form-options.js";
import type { ImportFormState } from "./import-panel-state.js";

export interface ImportOrchestratorDeps {
  /** Refresh the Tasks tab after a cron import created scheduled tasks. */
  refreshTasks?(): void;
  /** Refresh the session rail after a sessions import wrote new rows. */
  refreshSessions?(): void;
}

/**
 * Bridge between the Import tab state slice and the import logic. The
 * reducer never touches SQLite or the importers; every side-effecting
 * operation enters here first and emits `import_*` actions on the bus so
 * the reducer (and therefore the UI) stays consistent.
 *
 * Reuses the runtime's already-open stores — the CLI path opens its own
 * handles, but here those handles are owned by the runtime and must NOT
 * be closed. Only the per-run source (read-only access to the other
 * agent's state dir) is opened and closed locally, inside
 * `buildImportRunner`'s `close()`.
 */
export class ImportOrchestrator {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
    private readonly deps: ImportOrchestratorDeps = {},
  ) {}

  /** Dry-run preview — never writes. Emits `import_preview_ready`. */
  preview(form: ImportFormState): void {
    this.bus.emit({ type: "import_preview_started" });
    void this.runImport(form, false);
  }

  /** Execute the import — writes sessions / tasks / secrets. Emits `import_execute_done`. */
  execute(form: ImportFormState): void {
    this.bus.emit({ type: "import_execute_started" });
    void this.runImport(form, true);
  }

  /**
   * Shared preview/execute path. Resolves the option set + limit from the
   * form, runs the importer once, and emits the matching ready/done/failed
   * action. Deferred onto a microtask so the `running` mode renders before
   * the synchronous SQLite work begins.
   */
  private async runImport(
    form: ImportFormState,
    execute: boolean,
  ): Promise<void> {
    let limit: number | undefined;
    try {
      limit = parseLimit(form.limit);
    } catch (err) {
      this.bus.emit({ type: "import_failed", error: errorMessage(err) });
      return;
    }
    const options = resolveImportFormOptions(form);
    if (options.length === 0) {
      this.bus.emit({
        type: "import_failed",
        error: nothingSelectedNotice(form),
      });
      return;
    }

    // Let the `running` frame paint before the synchronous import runs.
    await Promise.resolve();

    const runner = buildImportRunner(
      this.runtime,
      form.source,
      form.sourceDir.trim(),
    );
    try {
      const report = await runner.run({
        options,
        execute,
        overwrite: form.overwrite,
        ...(limit !== undefined ? { limit } : {}),
      });
      this.emitResult(report, execute, options);
    } catch (err) {
      this.bus.emit({ type: "import_failed", error: errorMessage(err) });
    } finally {
      runner.close();
    }
  }

  /** Emit the ready/done action shared by every source. */
  private emitResult(
    report: ImportReport,
    execute: boolean,
    options: readonly string[],
  ): void {
    const storeWarning = this.describeUnreadableRows();
    if (execute) {
      this.bus.emit({
        type: "import_execute_done",
        report,
        ...(storeWarning ? { storeWarning } : {}),
      });
      this.bus.emit({
        type: "runtime_info",
        line: `import done: ${formatSummary(report)}`,
      });
      // Cron import may have created scheduled tasks — refresh the tab.
      if (options.includes("cron")) this.deps.refreshTasks?.();
      // Sessions import wrote rows the rail has not seen yet.
      if (options.includes("sessions")) this.deps.refreshSessions?.();
    } else {
      this.bus.emit({
        type: "import_preview_ready",
        report,
        ...(storeWarning ? { storeWarning } : {}),
      });
    }
  }

  /**
   * Rows in the destination store whose payload will not parse, phrased
   * for the report screen — or `null` when there are none.
   *
   * The count is discovered at boot, where it has nowhere to go: the
   * chat is on the start page and the list simply leaves those rows
   * out, so a truncated write looks like sessions that quietly went
   * missing. The import screen is where the operator is already asking
   * "did everything arrive?", which makes it the right place to answer.
   *
   * Read through an optional call because counting unreadable rows is a
   * capability of the newer store; against an older one this is silent
   * rather than a crash.
   */
  private describeUnreadableRows(): string | null {
    const store = this.runtime.sessionStore as {
      countUnreadable?: () => number;
    };
    let unreadable = 0;
    try {
      unreadable = store.countUnreadable?.() ?? 0;
    } catch {
      return null;
    }
    if (unreadable <= 0) return null;
    return unreadable === 1
      ? "1 session already in the store cannot be read and is not listed"
      : `${unreadable} sessions already in the store cannot be read and are not listed`;
  }

  /**
   * The first-run flow's multi-source run: every picked agent in plan
   * order, each with its own importer, folded into one report whose
   * item kinds carry the agent's name (`Claude Code sessions`) so the
   * summary reads without a legend. Every session is taken (no limit);
   * a destination that diverged stays a conflict — onboarding never
   * overwrites — and the answer lands on the bus as
   * `onboarding_import_report` / `onboarding_import_failed`.
   */
  async runOnboarding(
    plan: OnboardingImportPlan,
    execute: boolean,
  ): Promise<void> {
    // Let the busy frame paint before the synchronous SQLite work begins.
    await Promise.resolve();
    const items: ImportItemResult[] = [];
    let cronImported = false;
    let sessionsImported = false;
    try {
      for (const agent of plan.agents) {
        if (!agent.enabled) continue;
        const enabled = plan.options
          .filter((row) => row.agent === agent.id && row.enabled)
          .map((row) => row.option);
        if (enabled.length === 0) continue;
        const runner = buildImportRunner(this.runtime, agent.id, agent.dir);
        let report: ImportReport;
        try {
          report = await runner.run({
            options: enabled,
            execute,
            overwrite: false,
          });
        } finally {
          runner.close();
        }
        if (execute && enabled.includes("cron")) cronImported = true;
        if (execute && enabled.includes("sessions")) sessionsImported = true;
        for (const item of report.items) {
          items.push({
            ...item,
            kind: `${IMPORT_AGENT_LABELS[agent.id]} ${item.kind}`,
          });
        }
      }
    } catch (err) {
      this.bus.emit({
        type: "onboarding_import_failed",
        error: errorMessage(err),
      });
      return;
    }
    const report = buildReport(items, execute);
    this.bus.emit({
      type: "onboarding_import_report",
      report,
      executed: execute,
    });
    if (execute) {
      this.bus.emit({
        type: "runtime_info",
        line: `import done: ${formatSummary(report)}`,
      });
      if (cronImported) this.deps.refreshTasks?.();
      if (sessionsImported) this.deps.refreshSessions?.();
    }
  }

  shutdown(): void {
    // No timers or open handles to release — the per-run source is always
    // closed inside the runner's finally. Present for symmetry with the
    // other tab orchestrators.
  }
}

function parseLimit(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new ImportOptionError("limit must be a non-negative integer");
  }
  return value;
}

function formatSummary(report: ImportReport): string {
  const s = report.summary;
  return `migrated=${s.migrated} skipped=${s.skipped} conflict=${s.conflict} error=${s.error}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
