import { resolve } from "node:path";
import { render } from "ink";
import React from "react";
import { getConfig } from "../config/index.js";
import { createAgentRuntime, type AgentRuntime } from "../runtime/bootstrap.js";
import type { LogRecord, LogSink } from "../telemetry/structured-logger.js";
import type { MetricSample, MetricSink } from "../telemetry/metrics-collector.js";
import { makeTuiEventBus, TuiApp, type TuiEventBus } from "./tui-app.js";
import type { TuiSessionInfo } from "./tui-state.js";

interface TuiArgs {
  workingDir: string;
  maxSteps: number | null;
  noApproval: boolean;
}

function parseArgs(args: string[]): TuiArgs | { error: string } {
  let workingDir: string | null = null;
  let maxSteps: number | null = null;
  let noApproval = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    switch (flag) {
      case "--cwd":
      case "--working-dir": {
        const value = args[++i];
        if (!value) return { error: `${flag} requires a value` };
        workingDir = resolve(value);
        break;
      }
      case "--max-steps": {
        const value = args[++i];
        const parsed = value ? Number.parseInt(value, 10) : NaN;
        if (!Number.isFinite(parsed)) return { error: "--max-steps expects an integer" };
        maxSteps = parsed;
        break;
      }
      case "--no-approval":
        noApproval = true;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  return {
    workingDir: workingDir ?? process.cwd(),
    maxSteps,
    noApproval,
  };
}

/**
 * CLI entry for `atomic-agent tui`. Boots the full runtime once and stays
 * alive across multiple goals: every Enter in the goal input spawns a
 * fresh `SessionState`, runs the loop, and returns the UI to `idle`. The
 * browser, `llama-server` slot pool and skill registry are kept warm
 * between runs — that is the whole point of the chat-like mode.
 */
export async function tuiCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const config = getConfig();
  const approvalRequired = !parsed.noApproval && config.agent.approvalRequired;
  const maxSteps = parsed.maxSteps ?? config.agent.maxSteps;
  const bus = makeTuiEventBus();

  const logSink: LogSink = (record: LogRecord) => bus.emitLog(record);
  const metricSink: MetricSink = (sample: MetricSample) => bus.emitMetric(sample);

  const runtime = await createAgentRuntime({
    workingDir: parsed.workingDir,
    approvalRequired,
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
