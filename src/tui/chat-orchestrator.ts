import { homedir } from "node:os";
import { join } from "node:path";

import type { ProfileFact } from "../memory/profile-store.js";
import type { SkillCatalogEntry } from "../prompt/stable-prefix.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import type { SessionState } from "../session/session-state.js";
import { clearTtyScreen } from "./clear-tty-screen.js";
import { captureAndWriteDebugBundle } from "./debug-bundle/index.js";
import { LlmHealthPoller } from "./llm-health/llm-health-poller.js";
import { LocalModelsOrchestrator } from "./local-models/local-models-orchestrator.js";
import { TasksOrchestrator } from "./tasks/tasks-orchestrator.js";
import { SkillsOrchestrator } from "./skills/skills-orchestrator.js";
import { TuiTelegramOrchestrator } from "./telegram/tui-telegram-orchestrator.js";
import type { TuiEventBus } from "./tui-app.js";
import { turnsToMessages } from "./turns-to-messages.js";
import type { SessionPickerEntry, TuiState } from "./tui-state.js";

const DEBUG_BUNDLE_TRACE_LIMIT = 10;
const DEBUG_BUNDLE_DIR_NAME = "atomic-agent-debug";

export interface ChatOrchestratorOptions {
  maxSteps: number;
  /** Initial llama-server base URL for the footer health poller. */
  llamaUrl: string;
}

/** Multiline text for the chat transcript (`/memory`); feed still gets `runtime_info` lines. */
function formatProfileSystemMessage(facts: readonly ProfileFact[]): string {
  if (facts.length === 0) {
    return "user profile: (empty) — use memory.profile.set to record cross-session facts";
  }
  const sorted = [...facts].sort((a, b) => a.key.localeCompare(b.key));
  const header = `user profile (${sorted.length} fact${sorted.length === 1 ? "" : "s"})`;
  const lines = sorted.map((f) => `  - ${f.key}: ${f.value}`);
  return [header, ...lines].join("\n");
}

/** Multiline text for the chat transcript (`/skills`); feed still gets `runtime_info` lines. */
function formatSkillCatalogSystemMessage(
  catalog: readonly SkillCatalogEntry[],
): string {
  if (catalog.length === 0) {
    return "skill catalog: (none installed)";
  }
  const header = `skill catalog (${catalog.length} entr${catalog.length === 1 ? "y" : "ies"})`;
  const lines = catalog.map(
    (e) => `  - ${e.name} (${e.source}): ${e.description}`,
  );
  return [header, ...lines].join("\n");
}

/**
 * Owns the single live chat session. Each call to `sendMessage` queues a
 * macro-turn through `runtime.runTurn`; only one turn is in flight at any
 * time so the user can keep typing without racing the agent loop. Abort
 * cancels the current turn but keeps the session alive — that is what
 * sets chat mode apart from the legacy goal-runner.
 *
 * The Tasks tab surface (list/detail/create/cancel/run-now) is delegated
 * to `TasksOrchestrator`, which is constructed here and exposed via
 * `tasks` so `tui-command.ts` can wire its callbacks without reaching
 * into runtime internals.
 */
export class ChatOrchestrator {
  private session: SessionState | null = null;
  private currentController: AbortController | null = null;
  private quitting = false;
  private readonly queue: string[] = [];
  public exitCode = 0;
  public readonly tasks: TasksOrchestrator;
  public readonly skills: SkillsOrchestrator;
  public readonly localModels: LocalModelsOrchestrator;
  public readonly llmHealth: LlmHealthPoller;
  public readonly telegram: TuiTelegramOrchestrator;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
    private readonly options: ChatOrchestratorOptions,
  ) {
    this.tasks = new TasksOrchestrator(runtime, bus, {
      getCurrentSessionId: () => this.session?.id ?? null,
      switchSession: (id) => this.switchSession(id),
    });
    this.skills = new SkillsOrchestrator(runtime, bus);
    this.localModels = new LocalModelsOrchestrator(bus);
    this.llmHealth = new LlmHealthPoller(bus, options.llamaUrl);
    this.telegram = new TuiTelegramOrchestrator(runtime, bus);
  }

  start(): void {
    if (this.session) return;
    this.session = this.runtime.createSession();
    this.bus.emit({ type: "session_created", sessionId: this.session.id });
    this.llmHealth.start();
    this.telegram.start();
  }

  /** Update the llama-server URL tracked by the footer health poller. */
  updateLlamaUrl(nextUrl: string): void {
    this.llmHealth.updateUrl(nextUrl);
  }

  openSessionPicker(): void {
    const sessions = this.runtime.sessionStore
      .listRecent(25)
      .map((s) => toPickerEntry(s));
    this.bus.emit({ type: "session_picker_opened", sessions });
  }

  switchSession(sessionId: string): void {
    if (this.quitting) return;
    if (this.currentController) {
      this.bus.emit({
        type: "runtime_info",
        line: "cannot switch sessions while a turn is running — press Ctrl+C first",
      });
      return;
    }
    const loaded = this.runtime.sessionStore.load(sessionId);
    if (!loaded) {
      this.bus.emit({
        type: "runtime_info",
        line: `session ${sessionId} not found`,
      });
      return;
    }
    this.session = loaded;
    this.queue.length = 0;
    this.bus.emit({
      type: "session_switched",
      sessionId: loaded.id,
      workingDir: loaded.workingDir,
      messages: turnsToMessages(loaded.turns),
    });
    this.bus.emit({
      type: "runtime_info",
      line: `switched to session ${loaded.id} (${loaded.turnCount} turn${loaded.turnCount === 1 ? "" : "s"})`,
    });
  }

  dumpProfile(): void {
    try {
      const facts = this.runtime.profileStore.list();
      this.bus.emit({
        type: "system_message",
        text: formatProfileSystemMessage(facts),
      });
      if (facts.length === 0) {
        this.bus.emit({
          type: "runtime_info",
          line: "profile: (empty) — use memory.profile.set to record cross-session facts",
        });
        return;
      }
      const sorted = [...facts].sort((a, b) => a.key.localeCompare(b.key));
      this.bus.emit({
        type: "runtime_info",
        line: `profile (${sorted.length} fact${sorted.length === 1 ? "" : "s"}):`,
      });
      for (const fact of sorted) {
        this.bus.emit({
          type: "runtime_info",
          line: `  - ${fact.key}: ${fact.value}`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const line = `profile read failed: ${msg}`;
      this.bus.emit({ type: "runtime_info", line });
      this.bus.emit({ type: "system_message", text: line });
    }
  }

  /** Emit the installed skill catalog into chat + event feed (`/skills`). */
  dumpSkillCatalog(): void {
    try {
      const catalog = this.runtime.skillCatalog;
      this.bus.emit({
        type: "system_message",
        text: formatSkillCatalogSystemMessage(catalog),
      });
      if (catalog.length === 0) {
        this.bus.emit({ type: "runtime_info", line: "skills: (none installed)" });
        return;
      }
      this.bus.emit({
        type: "runtime_info",
        line: `skill catalog (${catalog.length}):`,
      });
      for (const e of catalog) {
        this.bus.emit({
          type: "runtime_info",
          line: `  - ${e.name} (${e.source}): ${e.description}`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const line = `skill catalog read failed: ${msg}`;
      this.bus.emit({ type: "runtime_info", line });
      this.bus.emit({ type: "system_message", text: line });
    }
  }

  newSession(): void {
    if (this.quitting) return;
    if (this.currentController) {
      this.bus.emit({
        type: "runtime_info",
        line: "cannot create a new session while a turn is running — press Ctrl+C first",
      });
      return;
    }
    this.session = this.runtime.createSession();
    this.queue.length = 0;
    clearTtyScreen(process.stdout);
    this.bus.emit({
      type: "session_switched",
      sessionId: this.session.id,
      workingDir: this.session.workingDir,
      messages: [],
    });
    this.bus.emit({
      type: "runtime_info",
      line: `new session ${this.session.id} created`,
    });
  }

  sendMessage(text: string): void {
    if (this.quitting) return;
    if (!this.session) this.start();
    if (this.currentController) {
      this.queue.push(text);
      return;
    }
    void this.runOneTurn(text);
  }

  private async runOneTurn(text: string): Promise<void> {
    if (!this.session) return;
    const controller = new AbortController();
    this.currentController = controller;
    try {
      const result = await this.runtime.runTurn(this.session, text, {
        maxSteps: this.options.maxSteps,
        signal: controller.signal,
        origin: "tui",
      });
      this.session = result.session;
      if (this.session.status === "failed") this.exitCode = 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bus.emit({ type: "runtime_info", line: `turn error: ${msg}` });
      this.exitCode = 1;
    } finally {
      if (this.currentController === controller) this.currentController = null;
    }
    const next = this.queue.shift();
    if (next !== undefined && !this.quitting) {
      void this.runOneTurn(next);
    }
  }

  /**
   * Dump a zipped snapshot of the TUI state plus NDJSON traces for the
   * most recent sessions into `~/Documents/atomic-agent-debug/`. The
   * heavy work (readFile + zip compression) is off-thread via
   * `Promise`, but we stash the snapshot synchronously so the archive
   * reflects the exact UI state at the moment `/dump` was submitted.
   */
  exportDebugBundle(state: TuiState): void {
    const traceDir = this.runtime.config.tracing.trace.dir;
    const traceEnabled = this.runtime.config.tracing.trace.enabled === true;
    const outDir = join(homedir(), "Documents", DEBUG_BUNDLE_DIR_NAME);
    const sessionIds = this.collectDebugSessionIds();
    this.bus.emit({
      type: "runtime_info",
      line: `debug bundle: collecting ${sessionIds.length} trace${
        sessionIds.length === 1 ? "" : "s"
      } into ${outDir}`,
    });
    void (async () => {
      try {
        const result = await captureAndWriteDebugBundle({
          state,
          traceDir,
          traceEnabled,
          sessionIds,
          outDir,
        });
        this.bus.emit({
          type: "runtime_info",
          line: `debug bundle written: ${result.path} (${formatBytes(result.bytes)}, ${result.includedTraces} trace${
            result.includedTraces === 1 ? "" : "s"
          }, ${result.skippedTraces} skipped)`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.bus.emit({
          type: "runtime_info",
          line: `debug bundle failed: ${msg}`,
        });
      }
    })();
  }

  private collectDebugSessionIds(): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    if (this.session?.id) {
      ids.push(this.session.id);
      seen.add(this.session.id);
    }
    try {
      for (const s of this.runtime.sessionStore.listRecent(
        DEBUG_BUNDLE_TRACE_LIMIT,
      )) {
        if (seen.has(s.id)) continue;
        ids.push(s.id);
        seen.add(s.id);
      }
    } catch {
      // session store read failure is non-fatal — we still export the
      // snapshot plus whatever traces we already collected.
    }
    return ids.slice(0, DEBUG_BUNDLE_TRACE_LIMIT);
  }

  abortCurrentTurn(): void {
    this.currentController?.abort();
  }

  quit(): void {
    if (this.quitting) return;
    this.quitting = true;
    this.queue.length = 0;
    this.currentController?.abort();
  }

  async shutdown(): Promise<void> {
    this.abortCurrentTurn();
    this.tasks.shutdown();
    this.skills.shutdown();
    this.localModels.shutdown();
    this.llmHealth.stop();
    this.telegram.shutdown();
    await this.runtime.shutdown();
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function toPickerEntry(state: SessionState): SessionPickerEntry {
  const firstUser = state.turns.find((t) => t.kind === "user");
  const preview = firstUser && firstUser.kind === "user" ? firstUser.text : "";
  return {
    sessionId: state.id,
    workingDir: state.workingDir,
    turnCount: state.turnCount,
    stepCount: state.stepCount,
    updatedAt: state.updatedAt,
    preview: preview.length > 0 ? preview : "(empty)",
  };
}
