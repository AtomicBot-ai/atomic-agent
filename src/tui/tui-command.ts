import { render } from "ink";
import React from "react";
import { getConfig } from "../config/index.js";
import { checkLlamaServer } from "../llm/llama-server-health.js";
import { createAgentRuntime, type AgentRuntime } from "../runtime/bootstrap.js";
import type { LogRecord, LogSink } from "../telemetry/structured-logger.js";
import type { MetricSample, MetricSink } from "../telemetry/metrics-collector.js";
import type { SessionState } from "../session/session-state.js";
import { clearTtyScreen } from "./clear-tty-screen.js";
import { parseTuiArgs } from "./tui-args.js";
import { persistUserLlamaUrl } from "./persist-user-llama-url.js";
import { runLlamaStartupGateIfNeeded } from "./run-llama-config-wizard.js";
import { makeTuiEventBus, TuiApp, type TuiEventBus } from "./tui-app.js";
import { turnsToMessages } from "./turns-to-messages.js";
import type { SessionPickerEntry, TuiSessionInfo } from "./tui-state.js";

/**
 * CLI entry for `atomic-agent tui`. Boots the full runtime once and stays
 * alive across multiple goals: every Enter in the goal input spawns a
 * fresh `SessionState`, runs the loop, and returns the UI to `idle`. The
 * browser, `llama-server` slot pool and skill registry are kept warm
 * between runs — that is the whole point of the chat-like mode.
 */
export async function tuiCommand(args: string[]): Promise<number> {
  const parsed = parseTuiArgs(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  getConfig();
  const skipLlamaWizard =
    parsed.skipLlamaSetup || process.env.ATOMIC_AGENT_TUI_SKIP_LLAMA_SETUP === "1";
  const startupGate = await runLlamaStartupGateIfNeeded({
    skipWizard: skipLlamaWizard,
  });
  if (startupGate === "aborted") return 1;
  const config = getConfig();
  const approvalRequired = !parsed.noApproval && config.agent.approvalRequired;
  const maxSteps = parsed.maxSteps ?? config.agent.maxSteps;
  const bus = makeTuiEventBus();

  const logSink: LogSink = (record: LogRecord) => bus.emitLog(record);
  const metricSink: MetricSink = (sample: MetricSample) => bus.emitMetric(sample);

  const runtime = await createAgentRuntime({
    workingDir: parsed.workingDir,
    approvalRequired,
    traceDefault: true,
    handlers: {
      onAgentEvent: (event) => bus.emitAgentEvent(event),
      onApprovalRequest: (request) => bus.emitApproval(request),
      onSkillRegistryChange: (entries) =>
        bus.emit({ type: "skill_count_changed", count: entries.length }),
      logSinks: [logSink],
      metricSinks: [metricSink],
    },
  });

  const sessionInfo: TuiSessionInfo = {
    sessionId: null,
    workingDir: parsed.workingDir,
    llamaUrl: config.llama.url,
    browserChannel: config.browser.channel,
    browserHeadless: config.browser.headless,
    approvalRequired,
    maxSteps,
    skillCount: runtime.skillCatalog.length,
  };

  const orchestrator = new ChatOrchestrator(runtime, bus, { maxSteps });

  const onSignal = (): void => orchestrator.quit();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  // Render into the primary terminal buffer (no alternate screen) so the
  // chat transcript lands in the host terminal's native scrollback and
  // the user can scroll the history with the wheel / scrollbar. The trade-
  // off is that the final frame stays in the terminal after exit — that
  // is acceptable for a conversational agent.
  const ink = render(
    React.createElement(TuiApp, {
      session: sessionInfo,
      bus,
      callbacks: {
        onAbort: () => orchestrator.abortCurrentTurn(),
        onQuit: () => orchestrator.quit(),
        onApprovalDecision: (approvalId, approved) => {
          runtime.approvals.resolve({
            approvalId,
            approved,
            reason: approved ? "tui-approved" : "tui-denied",
          });
        },
        onMessageSubmitted: (text) => orchestrator.sendMessage(text),
        onSessionPickerRequested: () => orchestrator.openSessionPicker(),
        onSessionSwitchRequested: (id) => orchestrator.switchSession(id),
        onSessionNewRequested: () => orchestrator.newSession(),
        onPersistLlamaUrl: (nextUrl) => {
          void (async () => {
            try {
              const health = await checkLlamaServer({
                url: nextUrl,
                retries: 0,
                backoffMs: 0,
                timeoutMs: 8000,
              });
              if (!health.reachable) {
                bus.emit({
                  type: "runtime_info",
                  line: `llama /health failed at ${nextUrl}: ${health.error ?? "unknown"}`,
                });
                return;
              }
              persistUserLlamaUrl(nextUrl);
              bus.emit({ type: "llama_url_changed", url: nextUrl });
              bus.emit({
                type: "runtime_info",
                line: `llama URL saved (${health.latencyMs}ms)`,
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              bus.emit({
                type: "runtime_info",
                line: `llama URL not saved: ${msg}`,
              });
            }
          })();
        },
      },
    }),
    { stdout: process.stdout, stderr: process.stderr, exitOnCtrlC: false },
  );

  orchestrator.start();

  bus.emit({
    type: "runtime_info",
    line: `runtime ready — llama ${config.llama.url}, browser ${config.browser.channel}`,
  });

  try {
    await ink.waitUntilExit();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    // `ink.clear()` wipes the live region of the final Ink frame; the
    // finalised chat messages printed by `<Static>` remain in the
    // terminal's scrollback so the user keeps their conversation log.
    ink.clear();
    await orchestrator.shutdown();
  }
  return orchestrator.exitCode;
}

interface OrchestratorOptions {
  maxSteps: number;
}

/**
 * Owns the single live chat session. Each call to `sendMessage` queues a
 * macro-turn through `runtime.runTurn`; only one turn is in flight at any
 * time so the user can keep typing without racing the agent loop. Abort
 * cancels the current turn but keeps the session alive — that is what
 * sets chat mode apart from the legacy goal-runner.
 */
class ChatOrchestrator {
  private session: import("../session/session-state.js").SessionState | null = null;
  private currentController: AbortController | null = null;
  private quitting = false;
  /** Pending messages queued while a turn is in flight. */
  private readonly queue: string[] = [];
  public exitCode = 0;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
    private readonly options: OrchestratorOptions,
  ) {}

  start(): void {
    if (this.session) return;
    this.session = this.runtime.createSession();
    this.bus.emit({ type: "session_created", sessionId: this.session.id });
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
    await this.runtime.shutdown();
  }
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
