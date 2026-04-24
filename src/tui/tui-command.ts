import { render } from "ink";
import React from "react";
import { getConfig } from "../config/index.js";
import { checkLlamaServer } from "../llm/llama-server-health.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import type { LogRecord, LogSink } from "../tracing/structured-logger.js";
import type { MetricSample, MetricSink } from "../tracing/metrics-collector.js";
import { ChatOrchestrator } from "./chat-orchestrator.js";
import { parseTuiArgs } from "./tui-args.js";
import { persistUserLlamaUrl } from "./persist-user-llama-url.js";
import { runLlamaStartupGateIfNeeded } from "./run-llama-config-wizard.js";
import { makeTuiEventBus, TuiApp } from "./tui-app.js";
import type { TuiSessionInfo } from "./tui-state.js";

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
        onMemoryDumpRequested: () => orchestrator.dumpProfile(),
        onSkillCatalogRequested: () => orchestrator.dumpSkillCatalog(),
        onPersistLlamaUrl: (nextUrl) => persistLlamaUrl(nextUrl, bus),
        onTasksAutoRefreshStart: () => orchestrator.tasks.startAutoRefresh(),
        onTasksRefreshRequested: () => orchestrator.tasks.refresh(),
        onTaskDetailRequested: (taskId) => orchestrator.tasks.openDetail(taskId),
        onTaskOpenSessionRequested: (taskId) =>
          orchestrator.tasks.openSession(taskId),
        onTaskCancelConfirmed: (taskId) => orchestrator.tasks.cancelTask(taskId),
        onTaskRunNowRequested: (taskId) => orchestrator.tasks.runNow(taskId),
        onTaskCreateSubmitted: (input) => orchestrator.tasks.createTask(input),
        onDebugBundleExportRequested: (state) =>
          orchestrator.exportDebugBundle(state),
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

function persistLlamaUrl(
  nextUrl: string,
  bus: ReturnType<typeof makeTuiEventBus>,
): void {
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
      bus.emit({ type: "runtime_info", line: `llama URL not saved: ${msg}` });
    }
  })();
}
