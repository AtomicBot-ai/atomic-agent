import { spawnSync } from "node:child_process";
import { isSea } from "node:sea";
import { render } from "ink";
import React from "react";
import { resolveBootApprovalLevel } from "../approval/approval-level.js";
import {
  formatDotenvReadWarning,
  getConfig,
  setConfigNoticeSink,
  type WhileBusySubmitMode,
} from "../config/index.js";
import { checkLlamaServer } from "../llm/llama-server-health.js";
import { describeLlamaHealthFailure } from "../llm/describe-llama-health-failure.js";
import { createAgentRuntime, type AgentRuntime } from "../runtime/bootstrap.js";
import type { LogRecord, LogSink } from "../tracing/structured-logger.js";
import type { MetricSample, MetricSink } from "../tracing/metrics-collector.js";
import { isKnownLocalModelId } from "../local-llm/index.js";
import { registerSession } from "../local-llm/session-registry.js";
import { enterAltScreen } from "./alt-screen.js";
import { enableSynchronizedOutput } from "./synchronized-output.js";
import { ChatOrchestrator } from "./chat-orchestrator.js";
import { parseTuiArgs,
  nonInteractiveStdinError,
  TUI_HELP,
} from "./tui-args.js";
import {
  persistUserLocalLlmUrl,
  pointsAtManagedDaemon,
} from "./persist-user-local-models-config.js";
import {
  persistUserTuiMouse,
  persistUserTuiTheme,
  persistUserWhileBusySubmit,
} from "./persist-user-tui-config.js";
import { createMouseStdin } from "./mouse/mouse-stdin.js";
import { makeMouseSource } from "./mouse/mouse-source.js";
import {
  enableMouseTracking,
  type MouseTrackingController,
} from "./mouse/mouse-tracking.js";
import { isLocalBackendConfigured } from "./local-backend-readiness.js";
import { needsOnboarding } from "./onboarding/needs-onboarding.js";
import { createOnboardingState } from "./onboarding/onboarding-state.js";
import {
  currentTerminalLaunchInput,
  openAgentTerminalWindow,
} from "./open-terminal-window.js";
import { detectKittyKeyboard } from "./detect-kitty-keyboard.js";
import { setShiftEnterNewline } from "./shift-enter-support.js";
import { makeTuiEventBus, TuiApp } from "./tui-app.js";
import {
  detectTerminalBackground,
  resolveStartupTheme,
} from "./theme/detect-terminal-background.js";
import { resolveThemeName, setActiveTheme, THEMES } from "./theme/theme.js";
import type { InitialTuiLayoutOptions, TuiSessionInfo } from "./tui-state.js";
import {
  loadUninstallPreview,
  performUninstall,
} from "./uninstall/uninstall-orchestrator.js";

/**
 * CLI entry for `atomic-agent tui`. Boots the full runtime once and stays
 * alive across multiple goals: every Enter in the goal input spawns a
 * fresh `SessionState`, runs the loop, and returns the UI to `idle`. The
 * browser, `llama-server` slot pool and skill registry are kept warm
 * between runs — that is the whole point of the chat-like mode.
 */
export async function tuiCommand(args: string[]): Promise<number> {
  const parsed = parseTuiArgs(args);
  if ("help" in parsed) {
    process.stdout.write(TUI_HELP);
    return 0;
  }
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  // A TUI needs a terminal — refuse a piped stdin with one sentence
  // instead of letting Ink's raw-mode requirement crash with a stack
  // trace. See `nonInteractiveStdinError` for the reasoning.
  const stdinError = nonInteractiveStdinError();
  if (stdinError) {
    process.stderr.write(`${stdinError}\n`);
    return 1;
  }
  // Config diagnostics ("created default config at …", "migrated config
  // v41 → v43 …") are collected instead of printed from here on. They are
  // written by the first `getConfig()`, which happens two lines below —
  // long before the alternate screen exists — so on stderr they land
  // above the interface and stay there for the whole session. Replayed
  // into the transcript once the app is mounted, and restored to stderr
  // when the TUI exits.
  const configNotices: string[] = [];
  setConfigNoticeSink((line) => configNotices.push(line));
  // Theme selection BEFORE any Ink render or stdin listener (the first-run
  // flow and the main render). An explicit
  // `tui.theme` (a registered name) wins; otherwise `"auto"` (or an unknown
  // name) falls back to OSC 11 terminal-background autodetection. Running the
  // probe here means its reply is never swallowed by another stdin consumer,
  // and both the optional wizard and the main TUI are themed. Autodetect
  // falls back to dark on any failure (non-TTY, no reply, timeout).
  const configuredTheme = getConfig().tui.theme;
  // `resolveThemeName` also rehomes the eleven names the registry used to
  // carry, so a config pinned to `dracula` lands on the nearest surviving
  // palette instead of silently falling through to autodetect.
  const resolvedTheme = resolveThemeName(configuredTheme);
  if (resolvedTheme) {
    setActiveTheme(THEMES[resolvedTheme]);
  } else {
    setActiveTheme(resolveStartupTheme(await detectTerminalBackground()));
  }
  // Ask the terminal whether it speaks the kitty keyboard protocol
  // BEFORE Ink starts reading stdin — see `detectKittyKeyboard`. It
  // decides two things: whether Shift+Enter can mean "newline" at all,
  // and therefore what the hint strip is allowed to promise.
  const kittyKeyboard = await detectKittyKeyboard();
  setShiftEnterNewline(kittyKeyboard);

  // The first-run flow is a screen inside the app now, not a program
  // that runs before it. That is what lets it sit on the alternate
  // screen (no stray stderr above the UI), react to a resize, and hand a
  // still-running model download over to the agent — none of which the
  // pre-render gate could do, because neither the alt screen nor the
  // runtime existed at the point it ran.
  const skipOnboarding =
    parsed.skipLlamaSetup || process.env.ATOMIC_AGENT_TUI_SKIP_LLAMA_SETUP === "1";
  const onboarding =
    !skipOnboarding && needsOnboarding()
      ? createOnboardingState(getConfig().localModels.url)
      : null;
  // TUI owns its own llama-server health UX (footer indicator +
  // LlmHealthPoller). Blocking `createAgentRuntime` on a startup probe
  // / `/props` fetch just freezes the terminal before the first frame
  // renders — especially painful in managed mode when the daemon is
  // still booting. Defer both: the runtime wires the real client +
  // `ModelProfileManager` and the manager hot-swaps to the correct
  // profile on the first turn refresh.
  const deferRuntimeHealthProbe = true;
  const config = getConfig();
  // Seed what Enter does while a turn is running from the persisted
  // preference, so a Ctrl+T flip survives a restart.
  const initialLayout: InitialTuiLayoutOptions = {
    onboarding,
    whileBusyMode: config.tui.whileBusySubmit,
    // The composer's route controls read these on the home screen, and
    // the local-models slice only refreshes while the Models tab is
    // open — unseeded, a managed install mislabels itself `custom`
    // until the operator visits that tab once.
    localModels: {
      configMode: config.localModels.mode,
      activeModelId:
        config.localModels.managed.modelId &&
        isKnownLocalModelId(config.localModels.managed.modelId)
          ? config.localModels.managed.modelId
          : null,
    },
  };
  const approvalLevel = resolveBootApprovalLevel(
    parsed.noApproval,
    config.agent.approvalLevel,
  );
  const maxSteps = parsed.maxSteps ?? config.agent.maxSteps;
  const bus = makeTuiEventBus();
  // Set when the user presses a key on the post-self-update restart prompt.
  // Honoured after the Ink app unmounts and the runtime shuts down: we
  // re-exec the freshly-installed binary in place (see end of this function).
  let restartRequested = false;
  // Set when the uninstall ladder's last key is pressed. The removal is
  // deliberately NOT done here: it runs after the Ink app unmounts and
  // `orchestrator.shutdown()` has closed the SQLite handles and stopped
  // llama-server, in the same post-exit slot the self-update restart
  // uses (see the end of this function).
  let uninstallRequested = false;

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
    approvalLevel,
    traceDefault: true,
    // The TUI is the one entry point a person actually launches; the
    // arg-parse / TTY early returns above have already run, so `--help`
    // and a non-TTY invocation never reach here.
    interactiveLaunch: true,
    handlers: {
      onAgentEvent: (event, sessionId) => bus.emitAgentEvent(event, sessionId),
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
    approvalLevel,
    maxSteps,
    completionMaxTokens: config.localModels.completionMaxTokens,
    skillCount: runtime.skillCatalog.length,
    // Read after the startup gate, so a local model picked in the wizard
    // moments ago already counts as configured for this launch.
    localBackendConfigured: isLocalBackendConfigured(),
  };

  const orchestrator = new ChatOrchestrator(runtime, bus, {
    maxSteps,
    llamaUrl: config.localModels.url,
  });
  orchestratorForChannelStatus = orchestrator;

  const onSignal = (): void => orchestrator.quit();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  // SIGHUP fires when the terminal window is closed. Without a handler
  // the default action kills the process before `orchestrator.shutdown()`
  // runs, orphaning the managed llama-server with the model still in
  // RAM/VRAM — the exact complaint in #52.
  process.once("SIGHUP", onSignal);

  // Mark this process as a live TUI session so `stopOnExit` teardown can
  // tell "last session exits, stop the daemon" from "another window is
  // still chatting, leave it running".
  const releaseSession = registerSession(config.paths.localModelsDataDir);

  const altScreen = enterAltScreen({ stdout: process.stdout, hideCursor: false });
  // Immediately after the alt screen and before the first render: every
  // frame from here on is bracketed as one synchronized update, so a
  // terminal that renders as bytes arrive shows whole frames instead of
  // half of the old one and half of the new.
  const synchronizedOutput = enableSynchronizedOutput({ stdout: process.stdout });

  // Mouse support. Enabling SGR tracking (1000 + 1006) is what makes
  // clicking panels, rows, tabs and the prompt work at all — the app
  // cannot see a click the terminal never reports. The cost is real and
  // was the reason this was previously left off: while reporting is on,
  // the terminal stops doing its own drag-to-select (Apple Terminal has
  // no Shift-bypass at all). So it is a toggle, not a fact of life —
  // `tui.mouse` in the config, `--mouse` / `--no-mouse` per run, and
  // `/mouse on|off` live. With reporting off, behaviour is exactly what
  // it was before: alternate-scroll (`\x1b[?1007h` from
  // `enterAltScreen`) turns the wheel into cursor keys, which
  // `handleAppKey.shouldTreatArrowAsChatScroll` routes into
  // `chat_scrolled`.
  //
  // The decoded events reach React through `mouseSource`; the bytes
  // themselves are stripped from the stream Ink reads, because Ink's key
  // parser would otherwise type them into the chat buffer.
  const mouseEnabled = parsed.mouse ?? config.tui.mouse;
  const mouseSource = makeMouseSource();
  let mouseTracking: MouseTrackingController | null = mouseEnabled
    ? enableMouseTracking({ stdout: process.stdout })
    : null;
  // `mouseTracking` is the single source of truth for "is the mouse on",
  // and it is read here on every report rather than captured, so
  // `setMouseEnabled` reassigning it takes effect immediately. Normally
  // a terminal that was told to stop reporting sends nothing anyway, but
  // this keeps `/mouse off` honest for the cases where it still does:
  // a multiplexer that swallowed the disable, or a bracketed paste whose
  // payload happens to contain an SGR report.
  const mouseStdin = createMouseStdin(process.stdin, (event) => {
    if (mouseTracking) mouseSource.emit(event);
  });
  const setMouseEnabled = (next: boolean | null): void => {
    if (next === null) {
      bus.emit({
        type: "system_message",
        text: `mouse support is ${mouseTracking ? "on" : "off"} — /mouse on|off to change`,
      });
      return;
    }
    if (next === Boolean(mouseTracking)) {
      bus.emit({
        type: "system_message",
        text: `mouse support already ${next ? "on" : "off"}`,
      });
      return;
    }
    if (next) {
      mouseTracking = enableMouseTracking({ stdout: process.stdout });
    } else {
      mouseTracking?.disable();
      mouseTracking = null;
    }
    try {
      persistUserTuiMouse(next);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      bus.emit({ type: "runtime_info", line: `mouse setting not saved: ${msg}` });
    }
    bus.emit({
      type: "system_message",
      text: next
        ? "mouse support on — click panels, rows and the prompt; wheel scrolls"
        : "mouse support off — the terminal's own text selection is back",
    });
  };

  const ink = render(
    React.createElement(TuiApp, {
      session: sessionInfo,
      bus,
      ...(initialLayout ? { initialLayout } : {}),
      callbacks: {
        onAbort: () => orchestrator.abortCurrentTurn(),
        onQuit: () => orchestrator.quit(),
        onApprovalDecision: (approvalId, approved, grant) => {
          runtime.approvals.resolve({
            approvalId,
            approved,
            reason: approved ? "tui-approved" : "tui-denied",
            ...(grant ? { grant } : {}),
          });
        },
        onApprovalRetarget: (approvalId, path) => {
          runtime.approvals.resolve({
            approvalId,
            approved: true,
            reason: "tui-approved (retargeted)",
            pathOverride: path,
          });
        },
        onApprovalReply: (approvalId, message) => {
          // Order matters: resolve first so the blocked tool call fails
          // fast with the operator's words, then steer. Steering before
          // the resolve would push the note at a turn still parked on
          // `await approvals.request(...)`.
          runtime.approvals.resolve({
            approvalId,
            approved: false,
            reason: message,
          });
          orchestrator.steerMessage(message);
        },
        onMessageSubmitted: (text) => orchestrator.sendMessage(text),
        onQueueClearRequested: () => orchestrator.clearQueue(),
        onMessageSteered: (text) => orchestrator.steerMessage(text),
        onWhileBusyModePersistRequested: (mode) =>
          persistWhileBusyMode(mode, bus),
        // The mode is a stance for this session, so it moves the live
        // ladder and the live plan flag and writes neither to
        // `config.json`. The Privacy tab remains the only surface that
        // persists an approval level — otherwise a session that passed
        // through `bypass` would leave the machine trusting everything
        // on the next boot.
        onCodingModeChanged: (_mode, resolved) => {
          runtime.setApprovalLevel(resolved.approvalLevel);
          runtime.setPlanMode(resolved.planMode);
        },
        onSessionPickerRequested: () => orchestrator.openSessionPicker(),
        onSessionSwitchRequested: (id) => orchestrator.switchSession(id),
        onSessionNewRequested: () => orchestrator.newSession(),
        onSessionDeleteConfirmed: (sessionId) =>
          orchestrator.deleteSession(sessionId),
        onUninstallPlanRequested: () =>
          void loadUninstallPreview(bus, config.paths.stateDir),
        onUninstallConfirmed: () => {
          uninstallRequested = true;
          orchestrator.quit();
        },
        onNewWindowRequested: () => openNewAgentWindow(parsed.workingDir, bus),
        onMemoryDumpRequested: () => orchestrator.dumpProfile(),
        onSkillCatalogRequested: () => orchestrator.dumpSkillCatalog(),
        onPersistLlamaUrl: (nextUrl) => persistLlamaUrl(nextUrl, bus, orchestrator, runtime),
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
        onTaskNewRequested: () => {
          // Sidebar `+ new` on the Tasks header: land on the Tasks debug
          // tab with the create form already open — the destination the
          // in-panel `n` key reaches, minus the walk. The form-open
          // action is the same one `n` dispatches, emitted on the bus
          // for the reason the sibling above spells out.
          bus.emit({ type: "ui_mode_set", mode: "debug" });
          bus.emit({ type: "tab_changed", tab: "tasks" });
          bus.emit({ type: "tasks_create_form_opened" });
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
        onSkillRemoveRequested: (name) =>
          void orchestrator.skills.requestRemove(name),
        onSkillRemoveConfirmed: (name) =>
          void orchestrator.skills.confirmRemove(name),
        onSkillEnableRequested: (name) =>
          void orchestrator.skills.setSkillDisabled(name, false),
        onSkillDisableRequested: (name) =>
          void orchestrator.skills.setSkillDisabled(name, true),
        onSkillHubOpen: () => void orchestrator.skills.openHub(),
        onSkillHubRefresh: () => void orchestrator.skills.refreshHub(),
        onSkillHubSearch: (query) =>
          void orchestrator.skills.searchHub(query),
        onSkillHubCardOpen: (row) => void orchestrator.skills.openHubCard(row),
        onSkillHubInstall: (identifier, source) =>
          void orchestrator.skills.installFromHub(identifier, source),
        onSkillInstallConfirmed: (identifier) =>
          void orchestrator.skills.confirmInstall(identifier),
        onSkillInstallCancelled: (identifier) =>
          void orchestrator.skills.cancelInstall(identifier),
        onMemoryAutoRefreshStart: () => orchestrator.memory.startAutoRefresh(),
        onMemoryDetailRequested: (row) => orchestrator.memory.openDetail(row),
        onMemoryOpenNoteRequested: (noteId) =>
          orchestrator.memory.openNoteById(noteId),
        onMemoryExpandNeighborsRequested: (noteId) =>
          orchestrator.memory.expandNoteNeighbors(noteId),
        onMcpAutoRefreshStart: () => orchestrator.mcp.startAutoRefresh(),
        onProvidersTabRefresh: () => {
          orchestrator.providers.refresh();
          // The catalog fetchers cache at module scope, so a fresh TUI
          // process starts on the short static lists. Kick the live
          // refresh here (TUI start + providers/LLM tab activation);
          // the warm-cache guard inside makes repeats free. Dispatching
          // a reducer action cannot do this: the keymap/reducer layer
          // never reaches the bus the orchestrator listens on, which is
          // exactly how the live lists went missing from the pickers.
          orchestrator.providers.prefetchCloudCatalogs();
          // Same for the inline Cloud-pane model list: the /v1/models
          // fetch for openai-compatible providers starts here so the
          // section is populated (or visibly loading) by the time the
          // pane renders.
          void orchestrator.providers.ensureInlineModels(null);
          // Mirror the effective fallback chain for the Fallback pane
          // (config-driven; no network). Re-reads live config so a hot
          // provider swap re-primes the head on tab re-entry.
          orchestrator.fallback.refresh();
        },
        onProvidersSetActiveText: (id) =>
          void orchestrator.providers.setActiveText(id),
        onProvidersSelectChatModel: (providerId, modelId) =>
          void orchestrator.providers.selectChatModel(providerId, modelId),
        onProvidersChatModelPickerRequested: (providerId) =>
          void orchestrator.providers.openChatModelPicker(providerId),
        onProvidersInlineModelsEnsureRequested: (providerId) =>
          void orchestrator.providers.ensureInlineModels(providerId),
        onProvidersSetActiveEmbedding: (id) =>
          void orchestrator.providers.setActiveEmbedding(id),
        onProvidersSelectEmbeddingModel: (providerId, modelId) =>
          void orchestrator.providers.selectEmbeddingModel(providerId, modelId),
        // Fallback pane edits: callbacks, not dispatched actions — only
        // this layer reaches the orchestrator that writes llm.fallback.*.
        onFallbackMoveRequested: (providerId, delta) =>
          orchestrator.fallback.move(providerId, delta),
        onFallbackAddRequested: (providerId) =>
          orchestrator.fallback.add(providerId),
        onFallbackRemoveRequested: (providerId) =>
          orchestrator.fallback.remove(providerId),
        onFallbackAppendLocalToggleRequested: () =>
          orchestrator.fallback.toggleAppendLocal(),
        onOnboardingStep: (step, outcome) => {
          runtime.reportOnboardingStep(step, outcome);
        },
        onOnboardingFinished: () => {
          // The flow wrote config while the runtime was already up, so
          // the registry still holds the old provider set. The cloud
          // branch reloads itself inside `completeWizard`; this covers
          // the local and custom-endpoint branches, whose llama-server
          // URL has just changed underneath the active provider.
          void runtime.reloadLlmProviders();
        },
        onProvidersWizardSubmit: (wizard) =>
          void orchestrator.providers.completeWizard(wizard),
        onProvidersWizardSubmitCancel: () =>
          orchestrator.providers.cancelWizardVerification(),
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
        onLocalModelsUseManagedRequested: () =>
          void orchestrator.localModels.useManagedMode(),
        onLocalModelsBackendPullRequested: () =>
          void orchestrator.localModels.pullBackend(),
        onLocalModelsRefreshRequested: () => void orchestrator.localModels.refresh(),
        onLocalModelsHfResolveRequested: (reference) =>
          void orchestrator.localModels.resolveHuggingFaceReference(reference),
        onLocalModelsHfLookupCancelRequested: () =>
          orchestrator.localModels.cancelHuggingFaceLookup(),
        onLocalModelsHfAddRequested: (repo, cursor) =>
          void orchestrator.localModels.addHuggingFaceChoice(repo, cursor),
        onLocalModelsDeviceCycleRequested: () =>
          void orchestrator.localModels.cycleManagedDevice(),
        onLocalModelsAutoUpdateToggleRequested: () =>
          void orchestrator.localModels.toggleBackendAutoUpdate(),
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
        onAnalyticsToggleRequested: () =>
          orchestrator.privacy.toggleAnalytics(),
        onAnalyticsSetEnabledRequested: (enabled) =>
          orchestrator.privacy.setAnalyticsEnabled(enabled),
        onApprovalLevelSetRequested: (level) =>
          orchestrator.privacy.setApprovalLevel(level),
        onPrivacyRefreshRequested: () => orchestrator.privacy.refresh(),
        onUpdateConfirmed: () => orchestrator.runUpdate(),
        onUpdateRestart: () => {
          restartRequested = true;
        },
        onMouseSupportRequested: setMouseEnabled,
      },
      // Unconditional on purpose. `mouseEnabled` is a startup-time
      // value, but `/mouse on` flips reporting *later* and cannot
      // re-parent an already-mounted tree — gating the prop on it meant
      // a session started with `tui.mouse: false` kept `mouse ===
      // undefined` forever, so `TuiApp`'s subscribe effect returned
      // early and the clicks the terminal had just started reporting
      // went nowhere while the UI claimed mouse support was on.
      // Subscribing costs nothing while the mouse is off: the forwarder
      // above is what decides whether anything is ever emitted.
      mouse: mouseSource,
    }),
    {
      stdin: mouseStdin.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      exitOnCtrlC: false,
      // `disambiguateEscapeCodes` alone: it is what makes Shift+Enter a
      // distinct keystroke (`ESC [ 13 ; 2 u`). `reportAllKeysAsEscapeCodes`
      // would reroute ordinary typing through CSI u as well, putting the
      // paste and text-insert paths at risk for nothing.
      //
      // `mode: "enabled"` rather than `"auto"`: Ink's own probe and the
      // App's reader both see the terminal's reply, so auto can type
      // `[?1u` into the composer before the first render. We already
      // asked, above, on a stdin nobody else was reading.
      ...(kittyKeyboard
        ? {
            kittyKeyboard: {
              mode: "enabled" as const,
              flags: ["disambiguateEscapeCodes" as const],
            },
          }
        : {}),
    },
  );

  orchestrator.start();

  bus.emit({
    type: "runtime_info",
    line: `runtime ready — local-llm ${config.localModels.url}, browser ${config.browser.channel}`,
  });
  for (const line of configNotices) bus.emit({ type: "runtime_info", line });
  configNotices.length = 0;

  // A `.env` that exists but could not be read means stored API keys were
  // silently dropped for this run (#59). The loader already wrote to
  // stderr, but that line scrolls away before the alt screen takes over
  // and is easy to miss, so repeat it as a warning chat message. Names +
  // errno only, never file content.
  if (config.dotenv.error) {
    bus.emit({
      type: "system_message",
      variant: "warn",
      text: formatDotenvReadWarning(config.dotenv.path, config.dotenv.error),
    });
  }

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
    process.off("SIGHUP", onSignal);
    try {
      // Diagnostics go back to stderr for whatever runs after the TUI.
      setConfigNoticeSink(null);
      mouseTracking?.disable();
      mouseStdin.dispose();
      altScreen.restore();
      // After the alt screen, so the restore's own writes are still
      // bracketed, and before `ink.clear()` for the same reason.
      synchronizedOutput.restore();
      ink.clear();
    } catch {
      // After SIGHUP the tty is gone and these writes raise EIO; the
      // daemon teardown below must still run.
    }
    await orchestrator.shutdown();
    releaseSession();
  }

  // Uninstall handoff. Ahead of the restart branch because the two are
  // mutually exclusive and this one has to win: re-exec'ing a binary we
  // just deleted would be the last thing the operator saw.
  if (uninstallRequested) {
    return performUninstall({ stateDir: config.paths.stateDir });
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

/**
 * Ctrl+N / `/window`: launch a second agent in a new OS terminal window.
 * Fire-and-forget — the result is reported into the chat log either way,
 * because a silently ignored keystroke is the worst possible outcome
 * here (the operator cannot tell "not implemented" from "nothing
 * happened").
 */
function openNewAgentWindow(
  workingDir: string,
  bus: ReturnType<typeof makeTuiEventBus>,
): void {
  void (async () => {
    const result = await openAgentTerminalWindow(
      currentTerminalLaunchInput(workingDir, isSea()),
    );
    if (result.ok) {
      bus.emit({
        type: "system_message",
        text: `opened a new atomic-agent window (${result.label})`,
      });
      return;
    }
    bus.emit({
      type: "system_message",
      variant: "warn",
      text: `could not open a new terminal window: ${result.reason}`,
    });
  })();
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

function persistWhileBusyMode(
  mode: WhileBusySubmitMode,
  bus: ReturnType<typeof makeTuiEventBus>,
): void {
  try {
    persistUserWhileBusySubmit(mode);
    bus.emit({
      type: "runtime_info",
      line:
        mode === "steer"
          ? "Enter now steers the running turn"
          : "Enter now queues behind the running turn",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    bus.emit({ type: "runtime_info", line: `mode not saved: ${msg}` });
  }
}

function persistLlamaUrl(
  nextUrl: string,
  bus: ReturnType<typeof makeTuiEventBus>,
  orchestrator: ChatOrchestrator,
  runtime: AgentRuntime,
): void {
  // Every verdict goes to BOTH channels: `runtime_info` keeps the feed
  // history, `providers_status` is the LLM panel's own status line — the
  // only line the operator can actually see while saving from the
  // External pane. Feed-only reporting is how a refused save looked like
  // "nothing happened" (stub-verified: the 404/steer verdicts never
  // rendered anywhere on the panel).
  const report = (line: string): void => {
    bus.emit({ type: "runtime_info", line });
    bus.emit({ type: "providers_status", line, source: "external" });
  };
  void (async () => {
    try {
      // Immediate feedback: the probe can take up to 8s against a dead
      // host, and a silent gap reads as a freeze (#65).
      report(`probing ${nextUrl}…`);
      const health = await checkLlamaServer({
        url: nextUrl,
        retries: 0,
        backoffMs: 0,
        timeoutMs: 8000,
        // Catch a --api-key server here, where the operator can act,
        // instead of on the first completion (llama.cpp exempts /health
        // from the key, so the plain probe passes).
        verifyAuth: true,
      });
      if (!health.reachable) {
        report(describeLlamaHealthFailure(health, nextUrl));
        return;
      }
      persistUserLocalLlmUrl(nextUrl);
      // Rebuild the registered provider: its base URL was frozen at boot
      // (health/vision requests would keep hitting the old address until
      // a restart). The config write above already reset the cache.
      await runtime.reloadLlmProvider("local-llama");
      bus.emit({ type: "llama_url_changed", url: nextUrl });
      orchestrator.updateLlamaUrl(nextUrl);
      // The URL only takes effect if the chat route points at
      // llama-server; a cloud provider would otherwise stay active and
      // the saved URL would look inert. Done after the probe so a dead
      // address never steals a working route, and skipped when the route
      // is already local so editing a URL stays quiet. `refresh()`
      // re-reads `localModels.mode` so the LLM tab stops claiming managed.
      if (getConfig().llm?.activeTextProvider !== "local-llama") {
        await orchestrator.providers.setActiveText("local-llama");
      }
      // An external server replaces the managed chat daemon, which would
      // otherwise keep its VRAM for a route nothing uses. Unless the new
      // URL *is* the managed daemon — stopping it would kill the server
      // we just pointed at. Both branches refresh the LLM tab so it stops
      // reporting managed mode.
      if (pointsAtManagedDaemon(nextUrl, getConfig().localModels.managed.port)) {
        await orchestrator.localModels.refresh();
      } else {
        await orchestrator.localModels.stopChatDaemonOnly();
      }
      report(`local-llm URL saved (${health.latencyMs}ms)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report(`local-llm URL not saved: ${msg}`);
    }
  })();
}
