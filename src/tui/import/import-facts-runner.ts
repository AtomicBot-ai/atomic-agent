import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { getConfig } from "../../config/index.js";
import {
  ImportFactsJobs,
  isLocalProviderEntry,
  saveImportFacts,
  startImportFacts,
  type ImportFactsServiceDeps,
} from "../../import/user-facts/index.js";
import { resolveLlmConfig } from "../../llm/provider/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";

import type { ImportFactsAction } from "./import-facts-reducer.js";
import type { ImportFactsUiState } from "./import-facts-state.js";

/** What the facts step's keys ask for (one callback, `onImportFacts`). */
export type ImportFactsCommand =
  | { kind: "open" }
  | { kind: "start"; facts: Pick<ImportFactsUiState, "kind" | "path" | "cloud" | "cloudProvider"> }
  | { kind: "stop"; jobId: string }
  | { kind: "save"; jobId: string; approvedIds: readonly string[] }
  | { kind: "close"; jobId: string | null };

/** How often the running job is read for "part N of M". */
export const IMPORT_FACTS_POLL_MS = 400;

/**
 * Runs the facts step (ATO-1627) in-process against the runtime's own
 * stores and providers, through the same service the desktop reaches
 * over HTTP (src/import/user-facts/import-facts-service.ts). Emits
 * `import_facts_*` actions only; no message text is logged.
 */
export class ImportFactsRunner {
  private readonly jobs = new ImportFactsJobs();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly emit: (action: ImportFactsAction) => void,
    private readonly pollMs = IMPORT_FACTS_POLL_MS,
  ) {}

  handle(cmd: ImportFactsCommand): void {
    if (cmd.kind === "open") this.open();
    else if (cmd.kind === "start") this.start(cmd.facts);
    else if (cmd.kind === "stop") this.jobs.stop(cmd.jobId);
    else if (cmd.kind === "save") this.save(cmd.jobId, cmd.approvedIds);
    else this.close(cmd.jobId);
  }

  dispose(): void {
    this.stopPolling();
  }

  private deps(): ImportFactsServiceDeps {
    const config = getConfig();
    const resolved = resolveLlmConfig(config);
    return {
      jobs: this.jobs,
      llm: {
        providers: resolved.providers,
        activeTextProvider: resolved.activeTextProvider,
        getProvider: (id) => this.runtime.providerRegistry.getProvider(id),
      },
      profileStore: this.runtime.profileStore,
      memoryStore: this.runtime.notesStore,
      stateDir: config.paths.stateDir,
    };
  }

  private open(): void {
    const resolved = resolveLlmConfig(getConfig());
    const active = resolved.providers.find((p) => p.id === resolved.activeTextProvider);
    const local = active && isLocalProviderEntry(active) ? active : resolved.providers.find(isLocalProviderEntry);
    const cloud = active && !isLocalProviderEntry(active) ? active : resolved.providers.find((p) => !isLocalProviderEntry(p));
    this.emit({ type: "import_facts_opened", localLabel: local?.id ?? null, cloudProvider: cloud?.id ?? null });
  }

  private start(f: Extract<ImportFactsCommand, { kind: "start" }>["facts"]): void {
    const path = expandPath(f.path.trim());
    if (!path) {
      this.emit({ type: "import_facts_failed", error: "type the path of the export .zip (or its folder)" });
      return;
    }
    if (f.cloud && !f.cloudProvider) {
      this.emit({ type: "import_facts_failed", error: "no cloud provider is set up; untick the cloud row to use the local model" });
      return;
    }
    try {
      const job = startImportFacts(this.deps(), {
        source: f.kind,
        path,
        // Ticking the cloud row on this screen IS the per-run consent; it is not stored.
        engine: f.cloud ? { kind: "cloud", provider: f.cloudProvider!, cloudConsent: true } : { kind: "local" },
      });
      this.emit({ type: "import_facts_started", jobId: job.id, providerId: job.providerId, local: job.local });
      this.poll(job.id);
    } catch (err) {
      this.emit({ type: "import_facts_failed", error: errorMessage(err) });
    }
  }

  private poll(jobId: string): void {
    this.stopPolling();
    this.timer = setInterval(() => {
      const job = this.jobs.get(jobId);
      if (!job) {
        this.stopPolling();
        this.emit({ type: "import_facts_failed", error: "the import ended unexpectedly" });
        return;
      }
      this.emit({ type: "import_facts_progress", progress: job.progress });
      if (job.state === "done" || job.state === "stopped") {
        this.stopPolling();
        this.emit({ type: "import_facts_found", candidates: job.candidates ?? [], stopped: job.state === "stopped" });
      } else if (job.state === "failed") {
        this.stopPolling();
        this.emit({ type: "import_facts_failed", error: job.error ?? "the import failed" });
      }
    }, this.pollMs);
    this.timer.unref?.();
  }

  private save(jobId: string, approvedIds: readonly string[]): void {
    try {
      const r = saveImportFacts(this.deps(), jobId, approvedIds);
      this.emit({
        type: "import_facts_saved",
        result: { saved: r.saved, skipped: r.skipped, conflicts: r.conflicts.length, failed: r.failed },
      });
    } catch (err) {
      this.emit({ type: "import_facts_failed", error: errorMessage(err) });
    }
  }

  private close(jobId: string | null): void {
    this.stopPolling();
    if (jobId) this.jobs.forget(jobId);
    this.emit({ type: "import_facts_closed" });
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function expandPath(p: string): string {
  if (!p) return "";
  const home = p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p;
  return isAbsolute(home) ? home : resolve(home);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
