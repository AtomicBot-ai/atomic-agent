import { render } from "ink";
import React from "react";
import { getConfig } from "../config/index.js";
import { checkLlamaServer } from "../llm/llama-server-health.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import type { LogRecord, LogSink } from "../tracing/structured-logger.js";
import type { MetricSample, MetricSink } from "../tracing/metrics-collector.js";
import { ChatOrchestrator } from "./chat-orchestrator.js";
import { parseTuiArgs } from "./tui-args.js";
import { persistUserLocalLlmUrl } from "./persist-user-local-models-config.js";
import {
  isManagedModeReadyOnDisk,
  runLocalModelsStartupGateIfNeeded,
} from "./run-local-models-config-wizard.js";
import { makeTuiEventBus, TuiApp } from "./tui-app.js";
import type { InitialTuiLayoutOptions, TuiSessionInfo } from "./tui-state.js";

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
  const startupGate = await runLocalModelsStartupGateIfNeeded({
    skipWizard: skipLlamaWizard,
  });
  if (startupGate === "aborted") return 1;
  // TUI owns its own llama-server health UX (footer indicator +
  // LlmHealthPoller). Blocking `createAgentRuntime` on a startup probe
  // / `/props` fetch just freezes the terminal before the first frame
  // renders — especially painful in managed mode when the daemon is
  // still booting. Defer both: the runtime wires the real client +
  // `ModelProfileManager` and the manager hot-swaps to the correct
  // profile on the first turn refresh.
  const deferRuntimeHealthProbe = true;
  // After the wizard, land the user on the Models tab when managed
  // mode is selected but nothing is ready on disk yet — they still
  // need to pick + pull a model before chat is useful. Fully-ready
  // managed setups and external-URL setups land in chat as usual.
  const initialLayout: InitialTuiLayoutOptions | undefined =
    startupGate === "saved_managed" && !isManagedModeReadyOnDisk()
      ? { uiMode: "debug", activeTab: "models" }
      : undefined;
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
    ...(deferRuntimeHealthProbe
      ? { overrides: { deferLlamaHealthCheck: true } }
      : {}),
  });

  const sessionInfo: TuiSessionInfo = {
    sessionId: null,
    workingDir: parsed.workingDir,
    llamaUrl: config.localModels.url,
    browserChannel: config.browser.channel,
    browserHeadless: config.browser.headless,
    approvalRequired,
    maxSteps,
    skillCount: runtime.skillCatalog.length,
  };

  const orchestrator = new ChatOrchestrator(runtime, bus, {
    maxSteps,
    llamaUrl: config.localModels.url,
  });

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
      ...(initialLayout ? { initialLayout } : {}),
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
        onPersistLlamaUrl: (nextUrl) => persistLlamaUrl(nextUrl, bus, orchestrator),
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
        onLocalModelsAutoRefreshStart: () => orchestrator.localModels.startAutoRefresh(),
        onLocalModelsPullRequested: (id) => void orchestrator.localModels.pullModel(id),
        onLocalModelsSetActiveRequested: (id) =>
          void orchestrator.localModels.setActive(id),
        onLocalModelsBackendPullRequested: () =>
          void orchestrator.localModels.pullBackend(),
        onLocalModelsRefreshRequested: () => void orchestrator.localModels.refresh(),
        onLocalModelsRemoveConfirmed: (id) => orchestrator.localModels.removeLocalModel(id),
        onLocalModelsStatusRequested: () => orchestrator.localModels.emitStatusLine(),
        onLocalModelsDaemonStartRequested: () =>
          void orchestrator.localModels.startDaemon(),
        onLocalModelsDaemonStopRequested: () =>
          void orchestrator.localModels.stopDaemon(),
        onLocalLlmLogsAutoRefreshStart: () =>
          orchestrator.localModels.startLogsAutoRefresh(),
        onLocalLlmLogsAutoRefreshStop: () =>
          orchestrator.localModels.stopLogsAutoRefresh(),
      },
    }),
    { stdout: process.stdout, stderr: process.stderr, exitOnCtrlC: false },
  );

  orchestrator.start();

  bus.emit({
    type: "runtime_info",
    line: `runtime ready — local-llm ${config.localModels.url}, browser ${config.browser.channel}`,
  });

  // If the user is in managed mode and the backend + model are ready
  // on disk, start the daemon immediately so there is no extra
  // "run this command in another terminal" step. No-op in external
  // mode or when the prerequisites are missing.
  void orchestrator.localModels.autoStartIfReady();

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
  orchestrator: ChatOrchestrator,
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
          line: `local-llm /health failed at ${nextUrl}: ${health.error ?? "unknown"}`,
        });
        return;
      }
      persistUserLocalLlmUrl(nextUrl);
      bus.emit({ type: "llama_url_changed", url: nextUrl });
      orchestrator.updateLlamaUrl(nextUrl);
      bus.emit({
        type: "runtime_info",
        line: `local-llm URL saved (${health.latencyMs}ms)`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      bus.emit({ type: "runtime_info", line: `local-llm URL not saved: ${msg}` });
    }
  })();
}
