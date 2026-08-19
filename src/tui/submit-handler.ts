import {
  dispatchSlashCommand,
  type SlashDispatchResult,
} from "./commands/slash-command-handler.js";
import { parseSlashCommand, slashPrefix } from "./commands/slash-command-parser.js";
import {
  filterSlashCommands,
  resolveSlashCommand,
} from "./commands/slash-commands.js";
import type { TuiAction } from "./tui-action.js";
import { isKnownLocalModelId } from "../local-llm/index.js";
import { isThemeName, setActiveTheme, THEME_NAMES, THEMES } from "./theme/theme.js";
import type { TuiAppCallbacks } from "./tui-app.js";
import type { WhileBusySubmitMode } from "../config/index.js";
import {
  canAcceptMessage,
  canTypeMessage,
  type TuiState,
} from "./tui-state.js";

type Dispatch = (action: TuiAction) => void;

/**
 * Pure-ish submit pipeline: inspects the current TUI state and the
 * editor buffer, then either dispatches a reducer action, forwards a
 * message to the orchestrator, or runs a slash command. Kept out of
 * `tui-app.tsx` so the app shell stays under the 300-LOC budget and the
 * submit logic is unit-reachable.
 */
export function handleEditorSubmit(
  buffer: string,
  state: TuiState,
  dispatch: Dispatch,
  callbacks: TuiAppCallbacks,
): void {
  if (state.themePickerOpen) {
    handleThemePickerSubmit(state, dispatch, callbacks);
    return;
  }

  if (state.sessionPickerOpen) {
    handleSessionPickerSubmit(state, dispatch, callbacks);
    return;
  }

  const trimmed = buffer.trim();
  if (trimmed.length === 0) return;

  /**
   * 1) `/name` or `/name args` for a **registered** command: run from the
   *    live buffer first, independent of palette state (avoids stale
   *    `slashQuery` / wrong highlight on Enter).
   * 2) Unknown `/token`: show an error, never treat as a user message.
   * 3) Palette: partial input (`/h`, or `/` only) uses the highlight.
   * 4) A lone `/` with no palette is a no-op (never send to the model).
   */
  if (trimmed.startsWith("/")) {
    const parsed = parseSlashCommand(trimmed);
    if (parsed !== null) {
      const resolved = resolveSlashCommand(parsed.name);
      if (resolved !== null) {
        runSlashCommand(trimmed, state, dispatch, callbacks);
        return;
      }
      if (parsed.name.length > 0) {
        runSlashCommand(trimmed, state, dispatch, callbacks);
        return;
      }
    }
  }

  if (state.slashPaletteOpen) {
    const query = slashPrefix(trimmed) ?? "";
    const completions = filterSlashCommands(query);
    const maxRow = Math.max(0, completions.length - 1);
    const safeCursor = Math.min(state.slashPaletteCursor, maxRow);
    const chosen = completions[safeCursor];
    if (chosen) {
      runSlashCommand(`/${chosen.name}`, state, dispatch, callbacks);
      return;
    }
  }

  if (trimmed.startsWith("/")) {
    return;
  }

  // A turn is already in flight. Two ways to land the message, chosen
  // by `whileBusyMode` (Ctrl+T, or `/steer` / `/queue` for one message):
  //   steer — fold it into the running turn at its next step boundary
  //   queue — park it and run it as its own turn afterwards
  // Either way it is never dropped, which is the whole point.
  if (!canAcceptMessage(state)) {
    if (!canTypeMessage(state)) return;
    submitWhileBusy(trimmed, state.whileBusyMode, dispatch, callbacks);
    return;
  }
  dispatch({ type: "message_submitted" });
  callbacks.onMessageSubmitted(trimmed);
}

/**
 * Commit the highlighted theme from the interactive picker: the palette was
 * already live-previewed by the arrow handlers, so here we just persist the
 * choice, store the name (re-render), and close the overlay. Esc handling
 * (revert) lives in the app shell's `onEscape`.
 */
function handleThemePickerSubmit(
  state: TuiState,
  dispatch: Dispatch,
  callbacks: TuiAppCallbacks,
): void {
  const name = THEME_NAMES[state.themePickerCursor];
  if (name) {
    setActiveTheme(THEMES[name]);
    callbacks.onThemePersistRequested?.(name);
    dispatch({ type: "theme_set", name });
  }
  dispatch({ type: "theme_picker_closed" });
  dispatch({ type: "input_changed", value: "" });
}

function handleSessionPickerSubmit(
  state: TuiState,
  dispatch: Dispatch,
  callbacks: TuiAppCallbacks,
): void {
  const entry = state.sessionPickerList[state.sessionPickerCursor];
  if (entry && callbacks.onSessionSwitchRequested) {
    callbacks.onSessionSwitchRequested(entry.sessionId);
  } else {
    dispatch({ type: "session_picker_closed" });
  }
  dispatch({ type: "input_changed", value: "" });
}

export function runSlashCommand(
  raw: string,
  state: TuiState,
  dispatch: Dispatch,
  callbacks: TuiAppCallbacks,
): void {
  const result: SlashDispatchResult = dispatchSlashCommand(raw);
  if (result.triggerDebugBundleDump) {
    callbacks.onDebugBundleExportRequested?.(state);
  }
  // Swap the active palette before dispatching `theme_set` so the forced
  // re-render reads the new colours through the theme proxy, then persist the
  // choice to the user config (`/theme <name>` direct path).
  if (result.setThemeName && isThemeName(result.setThemeName)) {
    setActiveTheme(THEMES[result.setThemeName]);
    callbacks.onThemePersistRequested?.(result.setThemeName);
  }
  for (const action of result.actions) {
    if (action.type === "providers_chat_model_picker_requested") {
      // A state no-op as a reducer action: the orchestrator that owns
      // the `/v1/models` fetch listens on the event bus, and dispatch
      // never reaches it. Route the request through the callback that
      // `tui-command` binds to `ProvidersOrchestrator.openChatModelPicker`,
      // like every other provider operation.
      callbacks.onProvidersChatModelPickerRequested?.(action.providerId);
      continue;
    }
    if (action.type === "providers_inline_models_ensure_requested") {
      // Same wiring rule for the inline Cloud-pane model list (`/model`):
      // the catalog ensure must reach
      // `ProvidersOrchestrator.ensureInlineModels` through the callback.
      callbacks.onProvidersInlineModelsEnsureRequested?.(action.providerId);
      continue;
    }
    dispatch(action);
  }
  if (result.systemMessage) {
    dispatch({ type: "runtime_info", line: result.systemMessage });
    dispatch({ type: "system_message", text: result.systemMessage });
  }
  if (result.clearBuffer) dispatch({ type: "input_changed", value: "" });
  dispatch({ type: "slash_palette_closed" });
  if (result.submitWhileBusy) {
    const { mode, text } = result.submitWhileBusy;
    // `/steer foo` / `/queue foo` on an idle session is just "send foo".
    if (canAcceptMessage(state)) {
      dispatch({ type: "message_submitted" });
      callbacks.onMessageSubmitted(text);
    } else if (canTypeMessage(state)) {
      submitWhileBusy(text, mode, dispatch, callbacks);
    }
  }
  if (result.queueVerb) runQueueVerb(result.queueVerb, state, dispatch, callbacks);
  if (result.triggerAbort) callbacks.onAbort();
  if (result.triggerQuit) {
    callbacks.onAbort();
    callbacks.onQuit();
  }
  if (result.triggerSessionPicker) callbacks.onSessionPickerRequested?.();
  if (result.triggerSessionNew) callbacks.onSessionNewRequested?.();
  if (result.triggerNewWindow) callbacks.onNewWindowRequested?.();
  if (result.triggerMemoryDump) callbacks.onMemoryDumpRequested?.();
  if (result.triggerSkillCatalogDump) callbacks.onSkillCatalogRequested?.();
  if (result.runModeSet) {
    callbacks.onRunModeChangeRequested?.(
      result.runModeSet,
      result.runModeCloudShare,
    );
  }
  if (result.persistLlamaUrl) {
    callbacks.onPersistLlamaUrl?.(result.persistLlamaUrl);
  }
  if (result.taskCancelId) callbacks.onTaskCancelConfirmed?.(result.taskCancelId);
  if (result.taskRunId) callbacks.onTaskRunNowRequested?.(result.taskRunId);
  if (result.skillEnableName) callbacks.onSkillEnableRequested?.(result.skillEnableName);
  if (result.skillDisableName) callbacks.onSkillDisableRequested?.(result.skillDisableName);
  if (result.skillHubBrowse) callbacks.onSkillHubOpen?.();
  if (result.skillHubSearchQuery !== undefined) {
    callbacks.onSkillHubSearch?.(result.skillHubSearchQuery);
  }
  if (result.skillHubInstallId) callbacks.onSkillHubInstall?.(result.skillHubInstallId);
  if (
    result.localModelsPullModelId &&
    isKnownLocalModelId(result.localModelsPullModelId)
  ) {
    callbacks.onLocalModelsPullRequested?.(result.localModelsPullModelId);
  }
  if (
    result.localModelsUseModelId &&
    isKnownLocalModelId(result.localModelsUseModelId)
  ) {
    callbacks.onLocalModelsSetActiveRequested?.(result.localModelsUseModelId);
  }
  if (result.triggerLocalModelsStatus) void callbacks.onLocalModelsStatusRequested?.();
  if (result.telegramVerb) {
    runTelegramVerb(result.telegramVerb, callbacks);
  }
  if (result.analyticsVerb) {
    switch (result.analyticsVerb) {
      case "enable":
        void callbacks.onAnalyticsSetEnabledRequested?.(true);
        break;
      case "disable":
        void callbacks.onAnalyticsSetEnabledRequested?.(false);
        break;
      case "status":
        callbacks.onPrivacyRefreshRequested?.();
        break;
    }
  }
  if (result.mouseVerb) {
    callbacks.onMouseSupportRequested?.(
      result.mouseVerb === "status" ? null : result.mouseVerb === "on",
    );
  }
  if (result.approvalLevelSet !== undefined) {
    void callbacks.onApprovalLevelSetRequested?.(result.approvalLevelSet);
  }
}

/**
 * Land a message that was submitted while a turn was running, in the
 * requested mode. Split out so `/steer` and `/queue` can reuse it for a
 * one-off override without flipping the persisted default.
 */
export function submitWhileBusy(
  text: string,
  mode: WhileBusySubmitMode,
  dispatch: Dispatch,
  callbacks: TuiAppCallbacks,
): void {
  if (mode === "steer" && callbacks.onMessageSteered) {
    dispatch({ type: "message_steered", text });
    callbacks.onMessageSteered(text);
    return;
  }
  dispatch({ type: "message_queued", text });
  callbacks.onMessageSubmitted(text);
}

/**
 * `/queue` needs the live queue to render, which `dispatchSlashCommand`
 * (a pure buffer -> result function) cannot see. The listing is built
 * here from `TuiState`; `clear` also tells the orchestrator to drop its
 * own copy so the two never diverge.
 */
function runQueueVerb(
  verb: NonNullable<SlashDispatchResult["queueVerb"]>,
  state: TuiState,
  dispatch: Dispatch,
  callbacks: TuiAppCallbacks,
): void {
  if (verb === "clear") {
    callbacks.onQueueClearRequested?.();
    const line =
      state.queuedMessages.length === 0
        ? "queue: already empty"
        : `queue: dropped ${state.queuedMessages.length} parked message${
            state.queuedMessages.length === 1 ? "" : "s"
          }`;
    dispatch({ type: "runtime_info", line });
    dispatch({ type: "system_message", text: line });
    return;
  }
  const text = formatQueueListing(state.queuedMessages);
  dispatch({ type: "runtime_info", line: text.split("\n")[0] ?? text });
  dispatch({ type: "system_message", text });
}

/** Multi-line `/queue` listing for the chat transcript. */
export function formatQueueListing(queued: readonly string[]): string {
  if (queued.length === 0) {
    return "queue: (empty) \u2014 messages sent while a turn is running are parked here";
  }
  const header = `queue (${queued.length} message${queued.length === 1 ? "" : "s"})`;
  const lines = queued.map((text, i) => `  ${i + 1}. ${text.replace(/\s+/g, " ").trim()}`);
  return [header, ...lines].join("\n");
}

function runTelegramVerb(
  verb: NonNullable<SlashDispatchResult["telegramVerb"]>,
  callbacks: TuiAppCallbacks,
): void {
  switch (verb) {
    case "enable":
    case "start":
      void callbacks.onTelegramSetEnabledRequested?.(true);
      return;
    case "disable":
    case "stop":
      void callbacks.onTelegramSetEnabledRequested?.(false);
      return;
    case "restart":
      void callbacks.onTelegramRestartRequested?.();
      return;
    case "pair":
      void callbacks.onTelegramStartPairingRequested?.();
      return;
    case "token":
      callbacks.onTelegramTokenPromptOpenRequested?.();
      return;
    case "clear-token":
      void callbacks.onTelegramClearTokenRequested?.();
      return;
    case "clear-owner":
      void callbacks.onTelegramClearOwnerRequested?.();
      return;
  }
}
