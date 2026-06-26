import { spawnSync } from "node:child_process";
import { isSea } from "node:sea";
import { render } from "ink";
import React from "react";
import { getConfig } from "../config/index.js";
import { checkLlamaServer } from "../llm/llama-server-health.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import type { LogRecord, LogSink } from "../tracing/structured-logger.js";
import type { MetricSample, MetricSink } from "../tracing/metrics-collector.js";
import { enterAltScreen } from "./alt-screen.js";
import { ChatOrchestrator } from "./chat-orchestrator.js";
import { parseTuiArgs } from "./tui-args.js";
import { persistUserLocalLlmUrl } from "./persist-user-local-models-config.js";
import { persistUserTuiTheme } from "./persist-user-tui-config.js";
import {
  isManagedModeReadyOnDisk,
  runLocalModelsStartupGateIfNeeded,
} from "./run-local-models-config-wizard.js";
import { makeTuiEventBus, TuiApp } from "./tui-app.js";
import {
  detectTerminalBackground,
  resolveStartupTheme,
} from "./theme/detect-terminal-background.js";
import { isThemeName, setActiveTheme, THEMES } from "./theme/theme.js";
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
  // Theme selection BEFORE any Ink render or stdin listener (the startup-gate
  // wizard and the main render). An explicit
  // `tui.theme` (a registered name) wins; otherwise `"auto"` (or an unknown
  // name) falls back to OSC 11 terminal-background autodetection. Running the
  // probe here means its reply is never swallowed by another stdin consumer,
  // and both the optional wizard and the main TUI are themed. Autodetect
  // falls back to dark on any failure (non-TTY, no reply, timeout).
  const configuredTheme = getConfig().tui.theme;
  if (isThemeName(configuredTheme)) {
    setActiveTheme(THEMES[configuredTheme]);
  } else {
    setActiveTheme(resolveStartupTheme(await detectTerminalBackground()));
  }
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
  // After the wizard, land the user on the LLM tab when managed
  // mode is selected but nothing is ready on disk yet — they still
  // need to pick + pull a model before chat is useful. Fully-ready
  // managed setups and external-URL setups land in chat as usual.
  const initialLayout: InitialTuiLayoutOptions | undefined =
    startupGate === "saved_managed" && !isManagedModeReadyOnDisk()
      ? { uiMode: "debug", activeTab: "llm" }
      : undefined;
  const config = getConfig();
  const approvalRequired = !parsed.noApproval && config.agent.approvalRequired;
  const maxSteps = parsed.maxSteps ?? config.agent.maxSteps;
  const bus = makeTuiEventBus();
  // Set when the user presses a key on the post-self-update restart prompt.
  // Honoured after the Ink app unmounts and the runtime shuts down: we
  // re-exec the freshly-installed binary in place (see end of this function).
  let restartRequested = false;

  const logSink: LogSink = (record: LogRecord) => bus.emitLog(record);
  const metricSink: MetricSink = (sample: MetricSample) => bus.emitMetric(sample);

  // Forward declaration: the channel-status sink needs the
  // orchestrator, but the orchestrator needs the runtime, which the
  // sink must already exist for. Bind a `let` slot now and resolve it
  // after construction; the closure stays inert until the runtime
  // emits its first transition.
  let orchestratorForChannelStatus: ChatOrchestrator | null = null;
  const runtime = await createAgentRuntime({
    workingDir: parsed.workingDir,
    approvalRequired,
    traceDefault: true,
    handlers: {
      onAgentEvent: (event) => bus.emitAgentEvent(event),
      onApprovalRequest: (request) => bus.emitApproval(request),
      onSkillRegistryChange: (entries) =>
        bus.emit({ type: "skill_count_changed", count: entries.length }),
      onChannelStatus: (status) => {
        // Telegram status flows through the panel orchestrator, which
        // both updates the panel slice and emits a runtime_info line
        // for the Feed tab. Future channels can fan out from this
        // single sink without touching the runtime contract.
        orchestratorForChannelStatus?.telegram.forwardStatus(status);
        bus.emit({
          type: "runtime_info",
          line: status.lastError
            ? `[${status.channel}] ${status.state}: ${status.lastError}`
            : `[${status.channel}] ${status.state}`,
        });
      },
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
  orchestratorForChannelStatus = orchestrator;

  const onSignal = (): void => orchestrator.quit();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const altScreen = enterAltScreen({ stdout: process.stdout, hideCursor: false });

  // Mouse-wheel scroll relies on the terminal's alternate-scroll mode
  // (`\x1b[?1007h`, enabled by `enterAltScreen`): while the alt screen
  // is active the wheel is translated by the terminal into cursor
  // up/down keys, which `handleAppKey.shouldTreatArrowAsChatScroll`
  // routes into `chat_scrolled`. Crucially we do NOT enable SGR mouse
  // tracking (1000 + 1006) — doing so would hand every click/drag to
  // the app and disable the terminal's native text selection (broken
  // entirely in Apple Terminal, which has no Shift-bypass). Keeping
  // capture off means drag-to-copy works natively everywhere, matching
  // opencode's default. The wheel only drives chat scroll while the
  // editor is focused and empty — an accepted trade-off for native
  // selection.

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
        onThemePersistRequested: (themeName) => persistThemeChoice(themeName, bus),
        onTasksAutoRefreshStart: () => orchestrator.tasks.startAutoRefresh(),
        onTasksRefreshRequested: () => orchestrator.tasks.refresh(),
        onTaskDetailRequested: (taskId) => orchestrator.tasks.openDetail(taskId),
        onSidebarTaskActivated: (taskId) => {
          // Sidebar Enter on a task: jump to the Tasks debug tab and
          // surface the detail view. Two dispatches because the keymap
          // layer cannot reach the bus directly — `tab_changed` flips
          // the active tab, then `openDetail` seeds the firings ring +
          // emits `tasks_detail_opened`.
          bus.emit({ type: "ui_mode_set", mode: "debug" });
          bus.emit({ type: "tab_changed", tab: "tasks" });
          orchestrator.tasks.openDetail(taskId);
        },
        onTaskOpenSessionRequested: (taskId) =>
          orchestrator.tasks.openSession(taskId),
        onTaskCancelConfirmed: (taskId) => orchestrator.tasks.cancelTask(taskId),
        onTaskRunNowRequested: (taskId) => orchestrator.tasks.runNow(taskId),
        onTaskCreateSubmitted: (input) => orchestrator.tasks.createTask(input),
        onSkillsAutoRefreshStart: () => orchestrator.skills.startAutoRefresh(),
        onSkillsRefreshRequested: () => orchestrator.skills.refresh(),
        onSkillDetailRequested: (name) =>
          void orchestrator.skills.openDetail(name),
        onSkillToggleRequested: (name) =>
          void orchestrator.skills.toggleSkill(name),
        onSkillEnableRequested: (name) =>
          void orchestrator.skills.setSkillDisabled(name, false),
        onSkillDisableRequested: (name) =>
          void orchestrator.skills.setSkillDisabled(name, true),
        onMemoryAutoRefreshStart: () => orchestrator.memory.startAutoRefresh(),
        onMemoryDetailRequested: (row) => orchestrator.memory.openDetail(row),
        onMemoryOpenNoteRequested: (noteId) =>
          orchestrator.memory.openNoteById(noteId),
        onMemoryExpandNeighborsRequested: (noteId) =>
          orchestrator.memory.expandNoteNeighbors(noteId),
        onMcpAutoRefreshStart: () => orchestrator.mcp.startAutoRefresh(),
        onProvidersTabRefresh: () =>
          orchestrator.providers.refresh(),
        onProvidersSetActiveText: (id) =>
          void orchestrator.providers.setActiveText(id),
        onProvidersSelectChatModel: (providerId, modelId) =>
          void orchestrator.providers.selectChatModel(providerId, modelId),
        onProvidersSetActiveEmbedding: (id) =>
          void orchestrator.providers.setActiveEmbedding(id),
        onProvidersSelectEmbeddingModel: (providerId, modelId) =>
          void orchestrator.providers.selectEmbeddingModel(providerId, modelId),
        onProvidersWizardSubmit: (wizard) =>
          void orchestrator.providers.completeWizard(wizard),
        onProvidersRemove: (id) =>
          void orchestrator.providers.removeProviderById(id),
        onImportPreview: (form) => orchestrator.import.preview(form),
        onImportExecute: (form) => orchestrator.import.execute(form),
        onMcpDetailRequested: (serverName) =>
          orchestrator.mcp.openDetail(serverName),
        onMcpAddServerSubmit: (json) => orchestrator.mcp.addServerFromJson(json),
        onMcpRemoveServer: (name) => orchestrator.mcp.removeServer(name),
        onDebugBundleExportRequested: (state) =>
          orchestrator.exportDebugBundle(state),
        onLocalModelsAutoRefreshStart: () => orchestrator.localModels.startAutoRefresh(),
        onLocalModelsPullRequested: (id, mode) =>
          void orchestrator.localModels.pullModel(id, mode),
        onLocalModelsSetActiveRequested: (id) =>
          void orchestrator.localModels.setActive(id),
        onLocalModelsBackendPullRequested: () =>
          void orchestrator.localModels.pullBackend(),
        onLocalModelsRefreshRequested: () => void orchestrator.localModels.refresh(),
        onLocalModelsDeviceCycleRequested: () =>
          void orchestrator.localModels.cycleManagedDevice(),
        onLocalModelsRemoveConfirmed: (id) =>
          void orchestrator.localModels.removeLocalModel(id),
        onLocalModelsStatusRequested: () => orchestrator.localModels.emitStatusLine(),
        onLocalModelsDaemonStartRequested: () =>
          void orchestrator.localModels.startDaemon(),
        onLocalModelsDaemonStopRequested: () =>
          void orchestrator.localModels.stopDaemon(),
        onLocalModelsEmbeddingPullRequested: (id) =>
          void orchestrator.localModels.pullEmbeddingModel(id),
        onLocalModelsEmbeddingSetActiveRequested: (id) =>
          void orchestrator.localModels.setActiveEmbedding(id),
        onLocalModelsEmbeddingToggleEnabledRequested: () =>
          void orchestrator.localModels.toggleEmbeddingEnabled(),
        onLocalModelsEmbeddingDisableRequested: () =>
          void orchestrator.localModels.disableEmbedding(),
        onLocalModelsEmbeddingStartRequested: () =>
          void orchestrator.localModels.startEmbeddingPairing(),
        onLocalModelsEmbeddingRemoveConfirmed: (id) =>
          void orchestrator.localModels.removeEmbeddingModel(id),
        onLocalModelsEmbeddingOnboardingResolved: (accept) =>
          void orchestrator.localModels.resolveEmbeddingOnboarding(accept),
        onLocalLlmLogsAutoRefreshStart: () =>
          orchestrator.localModels.startLogsAutoRefresh(),
        onLocalLlmLogsAutoRefreshStop: () =>
          orchestrator.localModels.stopLogsAutoRefresh(),
        onTelegramRefreshRequested: () => orchestrator.telegram.refreshSettings(),
        onTelegramToggleEnabledRequested: () => {
          // The toggle reads from the live runtime config rather than
          // a (possibly stale) UI mirror so multiple rapid hotkey
          // presses cannot land on a contradictory enabled bit.
          const cfg = runtime.config.telegram;
          return orchestrator.telegram.setEnabled(!cfg.enabled);
        },
        onTelegramSetEnabledRequested: (enabled) =>
          orchestrator.telegram.setEnabled(enabled),
        onTelegramRestartRequested: () => orchestrator.telegram.restart(),
        onTelegramTokenPromptOpenRequested: () =>
          bus.emit({ type: "telegram_token_prompt_opened" }),
        onTelegramTokenSubmitted: (buffer) =>
          orchestrator.telegram.submitToken(buffer),
        onTelegramClearTokenRequested: () =>
          orchestrator.telegram.clearToken(),
        onTelegramStartPairingRequested: () =>
          orchestrator.telegram.startPairing(),
        onTelegramCancelPairingRequested: () =>
          orchestrator.telegram.cancelPairing(),
        onTelegramDismissPairingResultRequested: () =>
          orchestrator.telegram.dismissPairingResult(),
        onTelegramClearOwnerRequested: () =>
          orchestrator.telegram.clearOwnerUserId(),
        onTelegramAdvanceConnectRequested: () =>
          orchestrator.telegram.advanceConnect(),
        onTelegramAdvancedToggleRequested: () =>
          orchestrator.telegram.toggleAdvanced(),
        onUpdateConfirmed: () => orchestrator.runUpdate(),
        onUpdateRestart: () => {
          restartRequested = true;
        },
      },
    }),
    {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      exitOnCtrlC: false,
    },
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

  // Fire-and-forget startup version check. Surfaces an in-app update
  // offer when a newer release is published; silently no-ops when
  // disabled, offline, rate-limited, or running a dev build.
  void orchestrator.checkForUpdate();

  try {
    await ink.waitUntilExit();
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    altScreen.restore();
    ink.clear();
    await orchestrator.shutdown();
  }

  // Self-update restart handoff. The runtime is fully shut down and the
  // terminal restored, so re-exec the (atomically-replaced) binary in place.
  // `process.execPath` keeps the same path after the installer's `mv`, but now
  // resolves to the new inode. `spawnSync` with inherited stdio hands the TTY
  // to the child and blocks until it exits, then we propagate its exit code —
  // a seamless restart without a detached-process race for the terminal.
  if (restartRequested) {
    process.stdout.write("restarting atomic-agent…\n");
    // SEA prepends an extra argv slot, so the real user args start at index 2
    // (see userArgsFromArgv in cli/index.ts). Re-using process.argv.slice(1)
    // here re-injects the invoke-path slot and the relaunched SEA process reads
    // it as the command name ("unknown command: atomic-agent"). Plain node keeps
    // the script path at index 1, so slice(1) stays correct there.
    const relaunchArgs = isSea()
      ? process.argv.slice(2)
      : process.argv.slice(1);
    const result = spawnSync(process.execPath, relaunchArgs, {
      stdio: "inherit",
    });
    if (typeof result.status === "number") return result.status;
    return orchestrator.exitCode;
  }
  return orchestrator.exitCode;
}

function persistThemeChoice(
  themeName: string,
  bus: ReturnType<typeof makeTuiEventBus>,
): void {
  try {
    persistUserTuiTheme(themeName);
    bus.emit({ type: "runtime_info", line: `theme saved: ${themeName}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    bus.emit({ type: "runtime_info", line: `theme not saved: ${msg}` });
  }
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
