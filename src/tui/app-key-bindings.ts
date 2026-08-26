import { CODING_MODES } from "./coding-mode.js";
import { handleComposerSwitchKey } from "./composer-switch/composer-switch-key-bindings.js";
import type { ComposerSwitchRow } from "./composer-switch/composer-switch-rows.js";
import { handleContextPanelKey } from "./context-panel-keys.js";
import type { Key } from "ink";
import {
  canGrantCategory,
  canGrantShape,
  type ApprovalGrantScope,
  type ApprovalRequest,
} from "../approval/approval-gate.js";
import { formatApprovalCategory } from "../approval/approval-level.js";
import type { WhileBusySubmitMode } from "../config/index.js";
import {
  handleMenuKey,
  isMenuLeaderKey,
  isMenuOpenKey,
  resolveLeaderChord,
} from "./menu/menu-keys.js";
import type { MenuNode } from "./menu/menu-registry.js";
import { cycleNavSlot, type NavSlot } from "./section.js";
import { selectSidebarTasks } from "./sidebar-tasks-selector.js";
import type { TuiAction } from "./tui-action.js";
import type { TuiState } from "./tui-state.js";
import { isUninstallConfirmed } from "./uninstall/uninstall-state.js";

/**
 * Number of **terminal rows** a single PageUp / PageDown keypress
 * scrolls (chat scroll offset is line-based since the smooth-scroll
 * refactor). Approximates "⅓ viewport" — measured / clamped by
 * `ChatLog` against the real content height, so a slightly generous
 * value is harmless on short chats and feels right on long ones.
 */
const CHAT_PAGE_DELTA = 8;
const CHAT_WHEEL_ARROW_DELTA = 2;

export interface AppKeyCallbacks {
  /**
   * Resolve a pending approval. `grant` records a session-scoped point
   * exception alongside the approval: `"category"` (`s`) silences the
   * request's whole category, `"shape"` (`a`, shell only) silences the
   * request's command binary. Absent = this call only (`y`).
   */
  /**
   * Approve the pending call at a target the operator typed instead of
   * the one proposed. The runtime hands the raw string to the tool,
   * which resolves and re-categorises it — see `os.fs.write`.
   */
  onApprovalRetarget?(approvalId: string, path: string): void;
  /**
   * A chat message submitted while an approval prompt is up. It denies
   * that one call with the message as its reason (so the model reads
   * the operator's words as the tool result) and lands the same text in
   * the running turn.
   */
  onApprovalReply?(approvalId: string, message: string): void;
  /** The operator confirmed "delete the session?" for this thread. */
  onSessionDeleteConfirmed?(sessionId: string): void;
  /** The word was typed and Enter pressed — take the app down and remove it. */
  onUninstallConfirmed?(): void;
  onApprovalDecision(
    approvalId: string,
    approved: boolean,
    grant?: ApprovalGrantScope,
  ): void;
  onAbort(): void;
  /** Persist the Enter-while-busy mode after a Ctrl+T flip. */
  onWhileBusyModePersistRequested?(mode: WhileBusySubmitMode): void;
  /** Open a fresh OS terminal window running atomic-agent (Ctrl+N, `/window`). */
  onNewWindowRequested?(): void;
  onQuit(): void;
  /** Optional — called when Enter is pressed on the focused sidebar row. */
  onSessionSwitchRequested?(sessionId: string): void;
  /**
   * Optional — called when Enter is pressed on a sidebar Tasks row.
   * The handler is expected to switch to the Tasks debug tab and open
   * the detail view for `taskId`.
   */
  onSidebarTaskActivated?(taskId: string): void;
  /** Optional — called when the user accepts the startup update offer. */
  onUpdateConfirmed?(): void;
  /**
   * Optional — called when the user presses any key after a self-update
   * settled (`updateStatus === "done"`) to re-exec the freshly-installed
   * binary. The handler is expected to arrange the process restart; the
   * key binding additionally dispatches `quit_requested` so Ink unmounts.
   */
  onUpdateRestart?(): void;
}

export interface AppKeyContext {
  state: TuiState;
  dispatch: (action: TuiAction) => void;
  callbacks: AppKeyCallbacks;
  /** True if a prior Ctrl+C is still armed inside the double-press window. */
  ctrlCArmed: boolean;
  /** Called when this key press should arm (or disarm) the Ctrl+C quit. */
  setCtrlCArmed: (armed: boolean) => void;
  /**
   * Whether the sidebar is currently rendered (depends on terminal
   * width). Tab cycles `editor → sidebar(sessions) → sidebar(tasks)
   * → editor` only when this is `true` *and* the UI is in chat mode;
   * otherwise Tab falls through to the nav-slot cycle. Ctrl+B always
   * cycles nav slots forward regardless of sidebar visibility, so
   * power users have a single key to walk the dashboard even when
   * the sidebar steals plain Tab.
   */
  sidebarVisible: boolean;
  /** True while a `ctrl+g` leader is waiting for its chord key. */
  menuLeaderArmed: boolean;
  setMenuLeaderArmed: (armed: boolean) => void;
  /** Navigate to a place, or run an action's slash command. */
  activateMenuNode: (node: MenuNode) => void;
  /**
   * Switches the transcript cap to auto, for `a` on the open context
   * panel. Optional: surfaces without a config writer simply do not
   * bind the key.
   */
  onSetCapAuto?: () => void;
  /** Run the row picked in one of the composer's route switches. */
  activateComposerSwitch: (row: ComposerSwitchRow) => void;
}

/**
 * Global key-binding reducer executed outside the editor focus. Returns
 * `true` when the key was handled (the editor should ignore it). This
 * function is side-effectful (calls into `callbacks`) but the state
 * mutation funnels through `dispatch`, preserving reducer purity.
 */
/**
 * A debug-tab surface that owns its own keys is open — a modal, a
 * confirm dialog, a wizard, or a focused text field. While one is up,
 * global claims (nav cycling, the running Esc-abort) must bow out so
 * the surface keeps its keystrokes.
 */
export function isPanelModalOpen(state: TuiState): boolean {
  const tasksTabBusy =
    state.uiMode === "debug" &&
    state.activeTab === "tasks" &&
    (state.tasksPanel.mode === "create" ||
      state.tasksPanel.cancelConfirm !== null ||
      state.tasksPanel.searchOpen);
  const skillsTabBusy =
    state.uiMode === "debug" &&
    state.activeTab === "skills" &&
    (state.skillsPanel.mode === "detail" ||
      state.skillsPanel.mode === "hub" ||
      state.skillsPanel.installConfirm !== null ||
      state.skillsPanel.removeConfirm !== null);
  const memoryTabBusy =
    state.uiMode === "debug" &&
    state.activeTab === "memory" &&
    state.memoryPanel.mode === "detail";
  const localModelsTabBusy =
    state.uiMode === "debug" &&
    state.activeTab === "models" &&
    (state.localModelsPanel.mode === "backendUpdate" ||
      state.localModelsPanel.removeConfirmId !== null);
  // Telegram tab disables the editor outright (the panel owns letter
  // hotkeys), so on entry Tab/Shift+Tab still cycle. The "busy" flag
  // applies only when a modal is open and Tab/letters need to be
  // captured by the modal layer instead of cycling away from it.
  const telegramTabBusy =
    state.uiMode === "debug" &&
    state.activeTab === "telegram" &&
    state.telegramPanel.mode !== "list";
  // MCP tab is "busy" while a modal is open: the add-server modal
  // owns its own MultiLineEditor and the panel must keep capturing
  // letter/Tab keys; the remove-confirm modal claims `y`/`n` and Esc
  // so the global nav cycler cannot eat the confirmation keystrokes.
  const mcpTabBusy =
    state.uiMode === "debug" &&
    state.activeTab === "mcp" &&
    (state.mcpPanel.addModal !== null || state.mcpPanel.removeConfirm !== null);
  const providersTabBusy =
    state.uiMode === "debug" &&
    state.activeTab === "providers" &&
    (state.providersPanel.wizard !== null ||
      state.providersPanel.removeConfirm !== null);
  const llmTabBusy =
    state.uiMode === "debug" &&
    state.activeTab === "llm" &&
    (state.providersPanel.wizard !== null ||
      state.providersPanel.removeConfirm !== null ||
      state.localModelsPanel.mode === "backendUpdate" ||
      state.localModelsPanel.pull !== null ||
      state.localModelsPanel.removeConfirmId !== null ||
      state.localModelsPanel.embeddingRemoveConfirmId !== null ||
      state.localModelsPanel.embeddingOnboardingPrompt !== null ||
      state.providersPanel.chatModelPicker !== null ||
      state.llmPanel.externalUrlDraft !== null ||
      state.llmPanel.stopLocalDaemonsPrompt !== null ||
      // Focused inline model filter is a text-entry surface: Tab/Ctrl+B
      // must not cycle the nav away mid-typing.
      (state.llmPanel.mode === "cloud" &&
        state.llmPanel.cloudModelFilterFocused));
  return (
    tasksTabBusy ||
    skillsTabBusy ||
    memoryTabBusy ||
    localModelsTabBusy ||
    telegramTabBusy ||
    mcpTabBusy ||
    providersTabBusy ||
    llmTabBusy
  );
}

/**
 * True when this Ctrl+C will be seen by the composer as "copy": a live
 * selection AND a focused editor. The conditions after the flag mirror
 * the states of `editorFocus` (tui-app.tsx) a selection can coexist
 * with — sidebar focus, an open menu / context panel, and an armed
 * leader all leave the selection standing while taking the keyboard
 * away, and Ctrl+C must keep its global meaning there.
 */
function composerOwnsCtrlC(state: TuiState, menuLeaderArmed: boolean): boolean {
  return (
    state.composerHasSelection &&
    state.uiMode === "chat" &&
    state.chatFocus === "editor" &&
    !state.menuOpen &&
    !state.contextPanelOpen &&
    !menuLeaderArmed
  );
}

export function handleAppKey(
  input: string,
  key: Key,
  ctx: AppKeyContext,
): boolean {
  const { state, dispatch, callbacks, ctrlCArmed, setCtrlCArmed } = ctx;
  // The right-click cut/copy/paste menu is dismissed by the next
  // keystroke, whatever it is — the way GUI menus behave. Esc is
  // consumed (its only meaning was "close this"); every other key falls
  // through and keeps its ordinary meaning after the close. Above the
  // onboarding swallow on purpose: the menu opens on onboarding editors
  // too, and the flow's key hook never learns it exists.
  if (state.contextMenu) {
    dispatch({ type: "context_menu_closed" });
    if (key.escape) return true;
  }
  // The first-run flow owns the whole terminal while it is up: there is
  // no chat, no panel and no menu behind it for a key to reach, and the
  // screen subscribes to `useInput` itself. Swallow everything here so a
  // keystroke is never acted on twice — except Ctrl+C, which must quit
  // from setup exactly as it quits from anywhere else.
  if (state.onboarding && !(key.ctrl && input === "c")) {
    // Any other key breaks an armed quit chord here too — the swallow
    // below never reaches the disarm that chat keys pass through, and
    // ctrl+c, x, ctrl+c must not quit during setup when it would not
    // have quit from chat.
    setCtrlCArmed(false);
    return true;
  }
  // Above the session dialog and above approvals: while the uninstall
  // ladder is up it is the only thing on screen that can be answered,
  // and a key that leaks past it would be a key aimed at a transcript
  // the operator has already stopped looking at.
  if (state.uninstall) {
    return handleUninstallKey(input, key, ctx);
  }
  if (state.sessionDelete) {
    return handleSessionDeleteKey(input, key, ctx);
  }
  // Only the visible thread's question is answerable from the
  // keyboard. The reducer never arms `pendingApproval` for another
  // session (a background request surfaces as a notice instead), but
  // the keys must not trust that invariant blind: a foreign request
  // here would otherwise turn Ctrl+C into a cross-session deny plus a
  // visible-turn abort in one press. Unmatched, keys fall through to
  // their ordinary meanings.
  if (
    state.pendingApproval &&
    state.pendingApproval.sessionId === state.session.sessionId
  ) {
    return handleApprovalKey(input, key, state.pendingApproval, ctx);
  }
  // A settled successful self-update parks the UI on a "press any key to
  // restart" prompt. The first keystroke (whatever it is) re-execs the new
  // binary; `quit_requested` then unmounts Ink so the restart handoff runs.
  if (state.updateStatus === "done") {
    callbacks.onUpdateRestart?.();
    dispatch({ type: "quit_requested" });
    return true;
  }
  // The update offer claims only y / n / Esc; anything else (Ctrl+C in
  // particular) falls through to the normal handlers below.
  if (state.updatePrompt && handleUpdateKey(input, key, ctx)) {
    return true;
  }
  // The mode menu is a dropdown on the composer's toolbar, so it takes
  // the keys while it is up — above the operator menu, because ctrl+p
  // should close it and open the menu rather than land on both.
  if (state.codingModeMenu) {
    if (key.escape) {
      dispatch({ type: "coding_mode_menu_closed" });
      return true;
    }
    if (key.upArrow || key.downArrow) {
      dispatch({
        type: "coding_mode_menu_cursor_moved",
        delta: key.downArrow ? 1 : -1,
      });
      return true;
    }
    if (key.return) {
      const picked = CODING_MODES[state.codingModeMenu.cursor];
      if (picked) dispatch({ type: "coding_mode_cycled", mode: picked });
      return true;
    }
    // Anything else closes the menu and is then handled normally: a
    // dropdown that swallowed every keystroke would strand an operator
    // who opened it by accident mid-sentence.
    dispatch({ type: "coding_mode_menu_closed" });
  }
  // The menu and its leader sit above every panel guard on purpose: they are
  // the way out of a panel, so a panel must never be able to swallow them.
  if (handleMenuKey(input, key, { state, dispatch, activate: ctx.activateMenuNode })) {
    return true;
  }
  // Below the menu on purpose: ctrl+p should still reach the menu from
  // an open context panel, and opening the menu closes the panel.
  if (
    handleContextPanelKey(input, key, {
      state,
      dispatch,
      ...(ctx.onSetCapAuto ? { onSetCapAuto: ctx.onSetCapAuto } : {}),
    })
  ) {
    return true;
  }
  // Same rung, same reason: the composer's route switches let ctrl-chords
  // through so the menu stays reachable from inside one. They open only
  // where the composer is the surface the operator is looking at — on a
  // Manage tab the row is off screen, and a switch anchored to it would
  // be a popup with no visible owner.
  if (
    handleComposerSwitchKey(input, key, {
      state,
      dispatch,
      activate: ctx.activateComposerSwitch,
      canOpen:
        state.uiMode === "chat" &&
        !state.slashPaletteOpen &&
        !state.pendingApproval &&
        !state.themePickerOpen &&
        !state.sessionPickerOpen &&
        !isPanelModalOpen(state),
    })
  ) {
    return true;
  }
  if (ctx.menuLeaderArmed) {
    ctx.setMenuLeaderArmed(false);
    const node = resolveLeaderChord(input, key);
    if (node) {
      ctx.activateMenuNode(node);
      return true;
    }
    // An unclaimed *bare* key is swallowed rather than passed on: a
    // mistyped leader must not leak a letter into the prompt or fire a
    // panel hotkey. A modified key was never a chord, though — it means
    // the operator changed their mind — so it only disarms and then falls
    // through to the bindings below, where `ctrl+c` still aborts the turn.
    if (!key.ctrl && !key.meta) return true;
  }
  if (!state.slashPaletteOpen && isMenuLeaderKey(input, key)) {
    ctx.setMenuLeaderArmed(true);
    return true;
  }
  if (!state.slashPaletteOpen && isMenuOpenKey(input, key)) {
    dispatch({ type: "menu_opened" });
    return true;
  }
  if (
    ctx.sidebarVisible &&
    state.uiMode === "chat" &&
    state.chatFocus === "sidebar"
  ) {
    if (handleSidebarKey(input, key, ctx)) return true;
  }
  if (key.ctrl && input === "c") {
    // With text selected in the composer, Ctrl+C copies it — the
    // convention every terminal-adjacent editor follows. The editor owns
    // that; arming the quit chord here would make the same keystroke
    // mean two things at once.
    // …but only while the composer is actually FOCUSED to receive it.
    // The flag alone is not enough: it is set by a component that
    // unmounts on every Observe / Manage tab, and it survives Tab into
    // the sidebar, an open menu, or an armed leader — all states where
    // the editor's own handler is inactive. Standing down then would
    // leave Ctrl+C claimed by nobody: no abort, no quit, until focus
    // returned. Mirror the parts of `editorFocus` that can coexist with
    // a live selection.
    if (composerOwnsCtrlC(state, ctx.menuLeaderArmed)) return false;
    if (ctrlCArmed) {
      callbacks.onAbort();
      callbacks.onQuit();
      dispatch({ type: "quit_requested" });
      return true;
    }
    setCtrlCArmed(true);
    if (state.status === "running" || state.status === "awaiting_approval") {
      callbacks.onAbort();
      dispatch({ type: "abort_requested" });
    }
    return true;
  }
  setCtrlCArmed(false);
  // Ctrl+T flips what Enter does while a turn is running (steer <-> queue).
  // Alt/Shift/Ctrl+Enter are all "insert newline" in the editor, so the
  // mode cannot live on a Return modifier; an explicit, visible toggle is
  // the honest alternative. Guarded like the other global claims so a
  // panel modal or the palette never has the mode flipped under it, and
  // placed after the Ctrl+C disarm so a flip cannot ride an armed quit.
  if (
    key.ctrl &&
    !key.shift &&
    !key.meta &&
    input === "t" &&
    !state.pendingApproval &&
    !state.slashPaletteOpen &&
    !isPanelModalOpen(state)
  ) {
    const next = state.whileBusyMode === "steer" ? "queue" : "steer";
    dispatch({ type: "while_busy_mode_changed", mode: next });
    callbacks.onWhileBusyModePersistRequested?.(next);
    return true;
  }
  // Esc aborts a turn in flight — the binding the hint strip advertises
  // for the whole time `status === "running"`. It has to be claimed here
  // rather than in the editor's own Esc handler because the editor is
  // `disabled` while a turn runs, which switches its `useInput` off and
  // makes the abort branch over there unreachable. Overlays that own Esc
  // themselves keep it; a pending approval already returned above.
  if (
    key.escape &&
    state.status === "running" &&
    !state.slashPaletteOpen &&
    !state.themePickerOpen &&
    !state.sessionPickerOpen &&
    // A panel modal / confirm / wizard / focused field owns Esc for its
    // own cancel; aborting the run out from under it would make one
    // keypress do two unrelated things (and some of those surfaces run
    // their own useInput, which Ink fires regardless of ours).
    !isPanelModalOpen(state)
  ) {
    // Scroll-reset keeps its precedence: Esc with the chat scrolled away
    // from the bottom snaps back to the latest reply before doing
    // anything else — the rung this branch now runs ahead of, and the
    // reason a mid-run PageUp + Esc must not destroy the turn. Only in
    // chat mode; on a debug tab the chat is off-screen, so a stale
    // offset there would just make Esc look dead.
    if (state.uiMode === "chat" && state.chatScrollOffset > 0) {
      dispatch({ type: "chat_scroll_reset" });
      return true;
    }
    callbacks.onAbort();
    dispatch({ type: "abort_requested" });
    return true;
  }
  if (
    state.uiMode === "chat" &&
    !state.slashPaletteOpen &&
    !state.pendingApproval
  ) {
    if (shouldTreatArrowAsChatScroll(input, key, state)) {
      dispatch({
        type: "chat_scrolled",
        delta: key.upArrow ? CHAT_WHEEL_ARROW_DELTA : -CHAT_WHEEL_ARROW_DELTA,
      });
      return true;
    }
    if (key.pageUp) {
      dispatch({ type: "chat_scrolled", delta: CHAT_PAGE_DELTA });
      return true;
    }
    if (key.pageDown) {
      dispatch({ type: "chat_scrolled", delta: -CHAT_PAGE_DELTA });
      return true;
    }
  }
  const debugTabBusy = isPanelModalOpen(state);
  // Ctrl+N opens a fresh OS terminal window running atomic-agent in the
  // same working dir. The editor never sees ctrl-modified letters
  // (it handles only ctrl+a/e/u/k/w/c), so no keystroke is stolen.
  if (
    !debugTabBusy &&
    !state.slashPaletteOpen &&
    !state.pendingApproval &&
    key.ctrl &&
    !key.shift &&
    !key.meta &&
    input === "n"
  ) {
    callbacks.onNewWindowRequested?.();
    return true;
  }
  // Ctrl+B is the dedicated nav-cycle escape valve: it always advances
  // one nav slot forward regardless of where focus currently is. This
  // is the key power users press when they want to reach Observe /
  // Manage without first clearing sidebar focus or re-pressing Tab to
  // walk through both sidebar panes.
  if (
    !debugTabBusy &&
    !state.slashPaletteOpen &&
    !state.pendingApproval &&
    key.ctrl &&
    !key.shift &&
    !key.meta &&
    input === "b"
  ) {
    const next = cycleNavSlot(state, 1);
    applyNavSlot(dispatch, next);
    return true;
  }
  // Tab / Shift+Tab routing:
  //   - In chat mode with the sidebar visible, plain Tab cycles
  //     editor → sidebar(sessions) → sidebar(tasks) → editor so the
  //     operator can reach the rail with a single key. The
  //     in-sidebar transition (sessions ↔ tasks) is handled in
  //     `handleSidebarKey`; the path here covers the "land into the
  //     sidebar from the editor" leg.
  //   - Shift+Tab always cycles nav slots backward — same key surface
  //     as before so muscle memory survives.
  //   - Outside chat (debug mode) or with sidebar collapsed, plain
  //     Tab cycles nav slots forward as a fallback so power users on
  //     narrow terminals are not stranded.
  if (
    !debugTabBusy &&
    !state.slashPaletteOpen &&
    key.tab &&
    !state.pendingApproval
  ) {
    if (key.shift) {
      const prev = cycleNavSlot(state, -1);
      applyNavSlot(dispatch, prev);
      return true;
    }
    if (
      ctx.sidebarVisible &&
      state.uiMode === "chat" &&
      state.chatFocus === "editor"
    ) {
      // Land in the sidebar at the section the operator left last.
      dispatch({ type: "chat_focus_set", focus: "sidebar" });
      return true;
    }
    const next = cycleNavSlot(state, 1);
    applyNavSlot(dispatch, next);
    return true;
  }
  return false;
}

/**
 * Last-resort Esc handling for the debug (Observe / Manage) panels,
 * called by `TuiApp` after the active panel's own key layer declined
 * the key. Esc that nobody claimed goes home to Run — the single
 * "back" gesture out of a panel, which previously did not exist (the
 * only way back was cycling Tab through every remaining sub-tab).
 *
 * Precedence is preserved by the caller passing `panelHandled`: modals,
 * search inputs, detail views and half-typed forms consume Esc in their
 * own layer first and never reach here. `editorFocus` guards the tabs
 * that leave the chat editor focused — there the editor's own input
 * hook owns Esc (scroll-reset / quit; abort is claimed earlier, by
 * `handleAppKey`) and must not double-act.
 *
 * Returns `true` when the key was consumed.
 */
export function handlePanelEscape(
  key: Key,
  opts: {
    panelHandled: boolean;
    editorFocus: boolean;
    dispatch: (action: TuiAction) => void;
  },
): boolean {
  if (!key.escape || opts.panelHandled || opts.editorFocus) return false;
  opts.dispatch({ type: "ui_mode_set", mode: "chat" });
  return true;
}

function shouldTreatArrowAsChatScroll(
  input: string,
  key: Key,
  state: TuiState,
): boolean {
  if (!key.upArrow && !key.downArrow) return false;
  if (input.length > 0) return false;
  if (state.chatFocus !== "editor") return false;
  if (state.sessionPickerOpen) return false;
  if (state.themePickerOpen) return false;
  if (state.inputValue.length > 0) return false;
  if (state.inputHistoryCursor !== null) return false;
  return true;
}

/**
 * Sidebar-focus key handler: navigates the active pane (Sessions or
 * Tasks), advances Tab through the panes, and dispatches the right
 * activation callback on Enter. Returns `true` when the key was
 * consumed so the global handler does not fall through to the
 * nav-cycle / editor pipeline.
 */
function handleSidebarKey(
  input: string,
  key: Key,
  ctx: AppKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  if (key.escape) {
    dispatch({ type: "chat_focus_set", focus: "editor" });
    return true;
  }
  // Tab cycles within the sidebar: sessions → tasks → editor (out).
  // Shift+Tab is left for the global handler so power users can step
  // back through the global nav slots from inside the rail too.
  if (key.tab && !key.shift) {
    if (state.sidebarSection === "sessions") {
      dispatch({ type: "sidebar_section_focused", section: "tasks" });
      return true;
    }
    // Already on Tasks → exit the rail and resume editor focus. Then
    // restore the section to "sessions" so the next Tab-in lands on
    // the same place the operator started.
    dispatch({ type: "chat_focus_set", focus: "editor" });
    dispatch({ type: "sidebar_section_focused", section: "sessions" });
    return true;
  }
  // Ctrl+B mirrors the VS Code gesture: drop sidebar focus back to
  // the editor without cycling through the second pane.
  if (key.ctrl && !key.shift && !key.meta && input === "b") {
    dispatch({ type: "chat_focus_set", focus: "editor" });
    return true;
  }
  if (key.upArrow) {
    if (state.sidebarSection === "tasks") {
      dispatch({ type: "sidebar_tasks_cursor_moved", delta: -1 });
    } else {
      dispatch({ type: "sidebar_cursor_moved", delta: -1 });
    }
    return true;
  }
  if (key.downArrow) {
    if (state.sidebarSection === "tasks") {
      dispatch({ type: "sidebar_tasks_cursor_moved", delta: 1 });
    } else {
      dispatch({ type: "sidebar_cursor_moved", delta: 1 });
    }
    return true;
  }
  // FINDING: deleting a thread was mouse-only, while the `[x]` is
  // painted whether or not mouse reporting is on — `/mouse off`, a
  // terminal without reporting, or simply keyboard-first operators had
  // a visible control they could not reach. Delete / `x` opens the same
  // confirmation the mark does.
  if (
    state.sidebarSection === "sessions" &&
    (key.delete || (!key.ctrl && !key.meta && input.toLowerCase() === "x"))
  ) {
    const entry = state.recentSessions[state.sidebarCursor];
    if (entry) {
      dispatch({
        type: "session_delete_requested",
        sessionId: entry.sessionId,
        preview: entry.preview,
      });
    }
    return true;
  }
  if (key.return) {
    if (state.sidebarSection === "tasks") {
      const visible = selectSidebarTasks(state.tasksPanel.rows);
      const row = visible[state.sidebarTasksCursor] ?? visible[0];
      if (row && callbacks.onSidebarTaskActivated) {
        callbacks.onSidebarTaskActivated(row.id);
      }
      return true;
    }
    const entry = state.recentSessions[state.sidebarCursor];
    if (entry && callbacks.onSessionSwitchRequested) {
      callbacks.onSessionSwitchRequested(entry.sessionId);
    }
    return true;
  }
  // Swallow letter-keys while sidebar is focused so they do not bleed
  // into the editor through the global useInput hook.
  if (input.length > 0 && !key.ctrl && !key.meta) return true;
  return false;
}

/**
 * Apply a nav slot — the one place that knows "run" means chat mode and
 * every other slot is a debug tab. Exported so a click on a status-bar
 * pill lands the operator in exactly the same state Tab would.
 */
export function applyNavSlot(
  dispatch: (action: TuiAction) => void,
  slot: NavSlot,
): void {
  if (slot.kind === "run") {
    dispatch({ type: "ui_mode_set", mode: "chat" });
    return;
  }
  dispatch({ type: "ui_mode_set", mode: "debug" });
  dispatch({ type: "tab_changed", tab: slot.tab });
}

function handleUpdateKey(
  input: string,
  key: Key,
  ctx: AppKeyContext,
): boolean {
  if (key.ctrl || key.meta) return false;
  const lower = input.toLowerCase();
  if (lower === "y") {
    ctx.callbacks.onUpdateConfirmed?.();
    return true;
  }
  if (lower === "n" || key.escape) {
    ctx.dispatch({ type: "update_dismissed" });
    return true;
  }
  return false;
}

/**
 * Human confirmation line for a just-issued session grant, dropped into
 * the chat transcript so the operator sees the grant land in the same
 * place approval decisions surface. Active-session grants are otherwise
 * invisible until a matching request goes silent; this is the honesty at
 * the point of action while the Privacy-panel listing is a follow-up.
 */
function grantConfirmation(
  request: ApprovalRequest,
  scope: ApprovalGrantScope,
): string {
  if (scope === "shape" && request.commandShape) {
    return `granted: ${request.commandShape} commands for this session`;
  }
  return `granted: ${formatApprovalCategory(request.category)} for this session`;
}

/**
 * Resolve a pending approval: tell the runtime, then fold the decision
 * into the reducer (and, for a grant, print the confirmation line).
 * Shared by the key handler and the approval modal's clickable
 * buttons — one implementation, so the two can never disagree about
 * what "approve" means.
 */
export function decideApproval(
  request: ApprovalRequest,
  approved: boolean,
  ctx: {
    dispatch: (action: TuiAction) => void;
    callbacks: Pick<AppKeyCallbacks, "onApprovalDecision">;
  },
  grant?: ApprovalGrantScope,
): void {
  // Call through without a trailing `undefined`: the callback's arity
  // is observable (tests spy on it, hosts may inspect `arguments`).
  if (grant) {
    ctx.callbacks.onApprovalDecision(request.approvalId, approved, grant);
  } else {
    ctx.callbacks.onApprovalDecision(request.approvalId, approved);
  }
  ctx.dispatch({
    type: "approval_resolved",
    approvalId: request.approvalId,
    approved,
  });
  if (approved && grant) {
    ctx.dispatch({
      type: "system_message",
      text: grantConfirmation(request, grant),
    });
  }
}

/** What a keystroke means to the approval prompt, if anything. */
export type ApprovalHotkey =
  | "approve"
  | "grant_category"
  | "grant_shape"
  | "edit_path"
  | "deny"
  | "abort";

/**
 * The chord each approval verb answers to, and the label the button
 * prints beside it.
 *
 * **Why chords and not letters.** The chat composer stays live while a
 * prompt is up — that is how an operator answers the agent in words
 * instead of a verdict — so a bare `y` is ambiguous by construction.
 * The old rule resolved it with the buffer: with nothing typed the
 * letters decided, and from the first character on every key was text.
 * That works right up until someone starts a message with "yes, but…",
 * at which point the `y` has already approved the call. A modified key
 * is never text, so the ambiguity does not arise and the buffer no
 * longer has to arbitrate.
 *
 * **Why these four letters.** Every one of them is unclaimed both by
 * the app's global chords and by the live editor underneath. That is
 * the whole constraint, and it is tighter than it looks:
 *
 *   - `ctrl+a` / `ctrl+e` / `ctrl+u` / `ctrl+k` / `ctrl+w` are the
 *     editor's own line-editing bindings (`multi-line-editor-keys.ts`).
 *     Claiming one would fix the typing collision in one direction and
 *     open it in the other — an operator mid-message would lose
 *     delete-word to a *deny*.
 *   - `ctrl+c` / `ctrl+p` / `ctrl+g` / `ctrl+l` / `ctrl+n` / `ctrl+o` /
 *     `ctrl+q` / `ctrl+r` / `ctrl+t` / `ctrl+x` are global.
 *   - `ctrl+s` is XOFF, which a terminal outside our raw mode (screen,
 *     an ssh hop with flow control on) can still eat.
 *
 * That leaves `ctrl+y`, `ctrl+d`, `ctrl+f` and `ctrl+b`.
 *
 * **Why `ctrl+b` does two jobs.** `[a]` (grant this command shape) is
 * offered only for a `shell` request, and `[e]` (edit the target path)
 * only where `redirectablePath` is set — which `os.fs.write` is the
 * only tool that does. The two can never be on screen together, so
 * they are one slot in the prompt and one chord on the keyboard. The
 * button says which one it currently is; `approval-key-arbitration`
 * pins the exclusivity so a future tool cannot quietly break it.
 */
export const APPROVAL_CHORDS = {
  approve: "y",
  deny: "d",
  grantCategory: "f",
  /** Shape grant and path edit share this — see above. */
  contextual: "b",
} as const;

/**
 * Resolve a keystroke against the pending approval prompt — the single
 * place that decides whether a key is a *decision* or ordinary *text*.
 *
 * Both key layers consult this: `handleApprovalKey` to act, and the
 * composer's `claimKey` guard to stand down. One function, so the two
 * can never disagree and double-handle a keystroke.
 */
export function approvalHotkey(
  state: TuiState,
  input: string,
  key: Key,
): ApprovalHotkey | null {
  const request = state.pendingApproval;
  if (!request) return null;
  // Never a verdict on another session's request — same scope guard as
  // `handleAppKey`, kept here too because the composer's claimKey
  // consults this function directly.
  if (request.sessionId !== state.session.sessionId) return null;
  // The target field owns every key while it is open.
  if (state.approvalPathDraft !== null) return null;
  // Esc keeps the old rule, and keeps it for the old reason: it is the
  // editor's "clear the draft" key too, so only an empty buffer lets it
  // abort the run. Unlike the letters it was never a *decision* — the
  // worst a misread Esc does is throw away a half-typed message.
  if (key.escape) return state.inputValue.length > 0 ? null : "abort";
  // Everything else is a chord. `meta` is excluded rather than ignored:
  // alt+y on a Mac terminal is a character, not a verdict.
  if (!key.ctrl || key.meta) return null;
  const lower = input.toLowerCase();
  if (lower === APPROVAL_CHORDS.approve) return "approve";
  if (lower === APPROVAL_CHORDS.deny) return "deny";
  if (lower === APPROVAL_CHORDS.grantCategory && canGrantCategory(request)) {
    return "grant_category";
  }
  if (lower === APPROVAL_CHORDS.contextual) {
    if (canGrantShape(request)) return "grant_shape";
    if (canEditPath(request)) return "edit_path";
  }
  return null;
}

/** Whether this request offers a retarget (`[e]`). */
export function canEditPath(request: ApprovalRequest): boolean {
  return typeof request.redirectablePath === "string"
    && request.redirectablePath.length > 0;
}

/**
 * Approve the pending call at `path` instead of the proposed target.
 * The prompt closes here; whether that path needs another prompt is the
 * tool's call, not the UI's — a target on a different rung of the
 * ladder comes back as a fresh request.
 */
export function submitApprovalPath(
  request: ApprovalRequest,
  path: string,
  ctx: {
    dispatch: (action: TuiAction) => void;
    callbacks: Pick<AppKeyCallbacks, "onApprovalRetarget">;
  },
): void {
  ctx.callbacks.onApprovalRetarget?.(request.approvalId, path);
  ctx.dispatch({ type: "approval_path_edit_closed" });
  ctx.dispatch({
    type: "approval_resolved",
    approvalId: request.approvalId,
    approved: true,
  });
}

/**
 * Keys for the "delete the session?" dialog. `y` deletes, `n` / Esc
 * cancels, ←/→ and Tab move between the two controls, Enter runs the
 * focused one — which starts on Cancel, so a reflexive Enter is a
 * no-op rather than a lost thread.
 *
 * Every other key is swallowed: while a destructive confirmation is up,
 * a stray letter must not reach the rail or the composer behind it.
 */
function handleSessionDeleteKey(
  input: string,
  key: Key,
  ctx: AppKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  const confirm = state.sessionDelete;
  if (!confirm) return false;
  // Ctrl+C is "stop everything", and while this dialog was up it reached
  // no layer at all — the operator could not abort a running turn or arm
  // the quit chord without dismissing the dialog first. Close it and let
  // the global handler have the key.
  if (key.ctrl && input === "c") {
    dispatch({ type: "session_delete_closed" });
    return false;
  }
  if (key.ctrl || key.meta) return false;
  const lower = input.toLowerCase();
  const close = (): void => dispatch({ type: "session_delete_closed" });
  if (key.escape || lower === "n") {
    close();
    return true;
  }
  if (lower === "y") {
    callbacks.onSessionDeleteConfirmed?.(confirm.sessionId);
    close();
    return true;
  }
  if (key.leftArrow || key.rightArrow || key.tab) {
    dispatch({
      type: "session_delete_cursor_set",
      cursor: confirm.cursor === "yes" ? "cancel" : "yes",
    });
    return true;
  }
  if (key.return) {
    if (confirm.cursor === "yes") {
      callbacks.onSessionDeleteConfirmed?.(confirm.sessionId);
    }
    close();
    return true;
  }
  return true;
}

/**
 * Keys for the uninstall ladder.
 *
 * Two rules carry the whole design. The first: `y` does nothing, on any
 * screen — the reflex answer to a confirm dialog must not be an answer
 * here. The second: on the last screen, Enter only means something once
 * the word has actually been typed, and every other printable key is
 * text going into that field rather than a command. There is no key
 * that skips a step and no key that means "yes" twice in a row.
 */
function handleUninstallKey(
  input: string,
  key: Key,
  ctx: AppKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  const flow = state.uninstall;
  if (!flow) return false;
  const close = (): void => dispatch({ type: "uninstall_closed" });

  // Nothing is answerable once the app is on its way down — including
  // Ctrl+C, which at that point would leave a half-removed install.
  if (flow.step === "closing") return true;

  // Ctrl+C closes the dialog and hands the key on, same contract the
  // session dialog has: "stop everything" must never be swallowed.
  if (key.ctrl && input === "c") {
    close();
    return false;
  }
  if (key.escape) {
    close();
    return true;
  }
  if (key.ctrl || key.meta) return false;

  if (flow.step === "loading" || flow.step === "failed") return true;

  if (flow.step === "review") {
    if (key.leftArrow || key.rightArrow || key.tab) {
      dispatch({
        type: "uninstall_cursor_set",
        cursor: flow.cursor === "cancel" ? "continue" : "cancel",
      });
      return true;
    }
    if (key.return) {
      // An empty plan has nothing to continue to, so Enter closes.
      if (flow.cursor === "continue" && (flow.preview?.rows.length ?? 0) > 0) {
        dispatch({ type: "uninstall_review_accepted" });
      } else {
        close();
      }
      return true;
    }
    return true;
  }

  // `confirm`: a text field with one accepted value.
  if (key.return) {
    if (!isUninstallConfirmed(flow.typed)) return true;
    dispatch({ type: "uninstall_started" });
    callbacks.onUninstallConfirmed?.();
    return true;
  }
  if (key.backspace || key.delete) {
    dispatch({ type: "uninstall_typed_set", typed: flow.typed.slice(0, -1) });
    return true;
  }
  if (input && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
    // Capped at a little over the word's length: a paste of a whole
    // paragraph should not become a field the operator has to clear
    // one backspace at a time.
    const typed = `${flow.typed}${input}`.slice(0, 32);
    dispatch({ type: "uninstall_typed_set", typed });
    return true;
  }
  return true;
}

function handleApprovalKey(
  input: string,
  key: Key,
  request: ApprovalRequest,
  ctx: AppKeyContext,
): boolean {
  // Ctrl+C keeps aborting even with a draft in the buffer: it is the
  // "stop everything" key, not a prompt answer.
  if (key.ctrl && input === "c") {
    decideApproval(request, false, ctx);
    ctx.callbacks.onAbort();
    ctx.dispatch({ type: "abort_requested" });
    return true;
  }
  switch (approvalHotkey(ctx.state, input, key)) {
    case "approve":
      decideApproval(request, true, ctx);
      return true;
    case "grant_category":
      decideApproval(request, true, ctx, "category");
      return true;
    case "grant_shape":
      decideApproval(request, true, ctx, "shape");
      return true;
    case "edit_path":
      ctx.dispatch({
        type: "approval_path_edit_opened",
        path: request.redirectablePath ?? "",
      });
      return true;
    case "deny":
      decideApproval(request, false, ctx);
      return true;
    case "abort":
      decideApproval(request, false, ctx);
      ctx.callbacks.onAbort();
      ctx.dispatch({ type: "abort_requested" });
      return true;
    default:
      return false;
  }
}
