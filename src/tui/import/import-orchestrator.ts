import type { AgentRuntime } from "../../runtime/bootstrap.js";
import {
  HermesImporter,
  HermesSource,
  ImportOptionError,
  resolveSelectedOptions,
  OpenclawImporter,
  OpenclawSource,
  OPENCLAW_DEFAULT_AGENT,
  resolveOpenclawOptions,
  type ImportOptionId,
  type OpenclawOptionId,
  type ImportReport,
} from "../../import/index.js";
import type { TuiEventBus } from "../tui-app.js";
import type { ImportFormState } from "./import-panel-state.js";

export interface ImportOrchestratorDeps {
  /** Refresh the Tasks tab after a cron import created scheduled tasks. */
  refreshTasks?(): void;
}

/**
 * Bridge between the Import tab state slice and the Hermes import logic.
 * The reducer never touches SQLite or the importer; every side-effecting
 * operation enters here first and emits `import_*` actions on the bus so
 * the reducer (and therefore the UI) stays consistent.
 *
 * Reuses the runtime's already-open `sessionStore` / `taskStore` — the
 * CLI path opens its own handles, but here those handles are owned by
 * the runtime and must NOT be closed. Only the per-run `HermesSource`
 * (read-only access to `~/.hermes`) is opened and closed locally.
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
  private async runImport(form: ImportFormState, execute: boolean): Promise<void> {
    let limit: number | undefined;
    try {
      limit = parseLimit(form.limit);
    } catch (err) {
      this.bus.emit({ type: "import_failed", error: errorMessage(err) });
      return;
    }

    // Let the `running` frame paint before the synchronous import runs.
    await Promise.resolve();

    try {
      if (form.source === "openclaw") {
        this.runOpenclaw(form, execute, limit);
      } else {
        this.runHermes(form, execute, limit);
      }
    } catch (err) {
      this.bus.emit({ type: "import_failed", error: errorMessage(err) });
    }
  }

  private runHermes(
    form: ImportFormState,
    execute: boolean,
    limit: number | undefined,
  ): void {
    const exclude: string[] = [];
    if (!form.sessions) exclude.push("sessions");
    if (!form.cron) exclude.push("cron");
    const options: ImportOptionId[] = resolveSelectedOptions({
      preset: "default",
      exclude,
      migrateSecrets: form.secrets,
    });
    if (options.length === 0) {
      this.bus.emit({
        type: "import_failed",
        error: "nothing selected to import — enable sessions, cron or secrets",
      });
      return;
    }
    const source = new HermesSource(form.sourceDir.trim());
    try {
      const importer = new HermesImporter({
        source,
        sessionStore: this.runtime.sessionStore,
        taskStore: this.runtime.taskStore,
        stateDir: this.runtime.config.paths.stateDir,
        maxAttempts: this.runtime.config.tasks.maxAttempts,
        workingDirFallback: process.cwd(),
      });
      const report = importer.run({
        options,
        execute,
        overwrite: form.overwrite,
        ...(limit !== undefined ? { limit } : {}),
      });
      this.emitResult(report, execute, options);
    } finally {
      source.close();
    }
  }

  private runOpenclaw(
    form: ImportFormState,
    execute: boolean,
    limit: number | undefined,
  ): void {
    const exclude: string[] = [];
    if (!form.sessions) exclude.push("sessions");
    if (!form.cron) exclude.push("cron");
    const options: OpenclawOptionId[] = resolveOpenclawOptions({ exclude });
    if (options.length === 0) {
      this.bus.emit({
        type: "import_failed",
        error: "nothing selected to import — enable sessions or cron",
      });
      return;
    }
    const source = new OpenclawSource(
      form.sourceDir.trim(),
      OPENCLAW_DEFAULT_AGENT,
    );
    try {
      const importer = new OpenclawImporter({
        source,
        sessionStore: this.runtime.sessionStore,
        taskStore: this.runtime.taskStore,
        maxAttempts: this.runtime.config.tasks.maxAttempts,
        workingDirFallback: process.cwd(),
      });
      const report = importer.run({
        options,
        execute,
        overwrite: form.overwrite,
        ...(limit !== undefined ? { limit } : {}),
      });
      this.emitResult(report, execute, options);
    } finally {
      source.close();
    }
  }

  /** Emit the ready/done action shared by every source. */
  private emitResult(
    report: ImportReport,
    execute: boolean,
    options: readonly string[],
  ): void {
    if (execute) {
      this.bus.emit({ type: "import_execute_done", report });
      this.bus.emit({
        type: "runtime_info",
        line: `import done: ${formatSummary(report)}`,
      });
      // Cron import may have created scheduled tasks — refresh the tab.
      if (options.includes("cron")) this.deps.refreshTasks?.();
    } else {
      this.bus.emit({ type: "import_preview_ready", report });
    }
  }

  shutdown(): void {
    // No timers or open handles to release — the per-run source is always
    // closed inside the runHermes/runOpenclaw finally. Present for symmetry
    // with the other tab orchestrators.
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
