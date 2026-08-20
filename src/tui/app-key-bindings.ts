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
  onApprovalDecision(
    approvalId: string,
    approved: boolean,
    grant?: ApprovalGrantScope,
  ): void;
  onAbort(): void;
  /** Uninstall overlay: re-preview the plan with the state scope flipped. */
  onUninstallPreviewRequested?(includeState: boolean): void;
  /** Uninstall overlay: run the confirmed plan. */
  onUninstallConfirmed?(includeState: boolean): void;
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

export function handleAppKey(
  input: string,
  key: Key,
  ctx: AppKeyContext,
): boolean {
  const { state, dispatch, callbacks, ctrlCArmed, setCtrlCArmed } = ctx;
  if (state.pendingApproval) {
    return handleApprovalKey(input, key, state.pendingApproval, ctx);
  }
  // The uninstall confirm claims y / s / n while it is open. Placed above
  // every other binding so a chord cannot fire underneath a destructive
  // dialog the operator is looking at.
  if (state.uninstallConfirm) {
    return handleUninstallConfirmKey(input, key, ctx);
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
  // The menu and its leader sit above every panel guard on purpose: they are
  // the way out of a panel, so a panel must never be able to swallow them.
  if (handleMenuKey(input, key, { state, dispatch, activate: ctx.activateMenuNode })) {
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
  if (state.uninstallConfirm) return false;
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

/**
 * Keys for the `/uninstall` confirmation overlay: `y` runs the shown
 * plan, `s` toggles the state directory in or out of it, `n` cancels.
 * Esc is handled by `onEscape` in `tui-app.tsx` alongside the other
 * overlays.
 *
 * Everything is ignored while a removal is in flight, so a repeated `y`
 * cannot fire the removal twice, and once it has finished the dialog
 * only accepts dismissal — there is nothing left to confirm.
 */
function handleUninstallConfirmKey(
  input: string,
  key: Key,
  ctx: AppKeyContext,
): boolean {
  const { state, dispatch, callbacks } = ctx;
  const confirm = state.uninstallConfirm;
  if (!confirm) return false;
  // A ctrl/meta-modified key was never aimed at this prompt.
  if (key.ctrl || key.meta) return false;
  if (confirm.submitting) return true;
  if (confirm.done !== null) {
    // Any of the dismissal keys closes the report.
    if (key.return || input.toLowerCase() === "n" || input.toLowerCase() === "y") {
      dispatch({ type: "uninstall_confirm_closed" });
      return true;
    }
    return true;
  }
  const lower = input.toLowerCase();
  if (lower === "y" || key.return) {
    callbacks.onUninstallConfirmed?.(confirm.includeState);
    return true;
  }
  if (lower === "s") {
    callbacks.onUninstallPreviewRequested?.(!confirm.includeState);
    return true;
  }
  if (lower === "n") {
    dispatch({ type: "uninstall_confirm_closed" });
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
  // A ctrl/meta-modified key was never aimed at the y/n/esc prompt —
  // letting it through turns a global chord (ctrl+n) into a silent deny.
  if (key.ctrl || key.meta) return false;
  const lower = input.toLowerCase();
  if (lower === "y") {
    decideApproval(request, true, ctx);
    return true;
  }
  if (lower === "s" && canGrantCategory(request)) {
    decideApproval(request, true, ctx, "category");
    return true;
  }
  if (lower === "a" && canGrantShape(request)) {
    decideApproval(request, true, ctx, "shape");
    return true;
  }
  if (lower === "n") {
    decideApproval(request, false, ctx);
    return true;
  }
  if (key.escape || (key.ctrl && input === "c")) {
    decideApproval(request, false, ctx);
    ctx.callbacks.onAbort();
    ctx.dispatch({ type: "abort_requested" });
    return true;
  }
  return false;
}
