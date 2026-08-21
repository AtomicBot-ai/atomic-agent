import type { AgentLoopEvent } from "../agent/agent-loop.js";
import type { ApprovalRequest } from "../approval/approval-gate.js";
import type { MetricSample } from "../tracing/metrics-collector.js";
import type { LogRecord } from "../tracing/structured-logger.js";
import type { LocalModelsAction } from "./local-models/local-models-actions.js";
import type { TasksAction } from "./tasks/tasks-actions.js";
import type { SkillsAction } from "./skills/skills-actions.js";
import type { MemoryAction } from "./memory/memory-actions.js";
import type { McpAction } from "./mcp/mcp-actions.js";
import type { ImportAction } from "./import/import-actions.js";
import type { TelegramAction } from "./telegram/telegram-actions.js";
import type { PrivacyAction } from "./privacy/privacy-actions.js";
import type { ProvidersAction } from "./providers/providers-actions.js";
import type { LlmPanelAction } from "./llm-panel/llm-panel-actions.js";
import type { FallbackPanelAction } from "./llm-panel/fallback/fallback-panel-actions.js";
import type { WhileBusySubmitMode } from "../config/index.js";
import type { ChatMessage, SessionPickerEntry, TuiTab, TuiUiMode } from "./tui-state.js";

/**
 * Every action the reducer knows how to fold into `TuiState`. All side
 * effects (abort controller, approval gate, process exit) stay outside —
 * the reducer is pure so it is unit-testable and deterministic under
 * replay. New UX actions (ui mode toggle, slash palette, tool expand,
 * input history) are listed alongside the legacy agent-event actions.
 */
export type TuiAction =
  | { type: "runtime_info"; line: string }
  /** Append a local system message directly into the chat transcript. */
  | { type: "system_message"; text: string; variant?: "normal" | "warn" }
  | { type: "agent_event"; event: AgentLoopEvent }
  | { type: "approval_requested"; request: ApprovalRequest }
  /** The `x` on a rail session row: ask before removing the thread. */
  | { type: "session_delete_requested"; sessionId: string; preview: string }
  | { type: "session_delete_cursor_set"; cursor: "yes" | "cancel" }
  | { type: "session_delete_closed" }
  | { type: "approval_resolved"; approvalId: string; approved: boolean }
  | { type: "metric"; sample: MetricSample }
  | { type: "log"; record: LogRecord }
  | { type: "skill_count_changed"; count: number }
  /**
   * Mirror the live approval-gate state into `state.session` so the
   * diagnostics line ("approval on/off") tracks the Privacy-tab toggle.
   */
  | { type: "approval_level_changed"; approvalLevel: number }
  | { type: "session_created"; sessionId: string }
  | { type: "tab_changed"; tab: TuiTab }
  | { type: "ui_mode_toggled" }
  | { type: "ui_mode_set"; mode: TuiUiMode }
  /**
   * Record the active theme name so the app re-renders after a runtime
   * `/theme <name>` switch. The actual palette swap (`setActiveTheme`) is a
   * side effect performed by the submit handler before this action lands;
   * the reducer only stores the name to trigger the re-render.
   */
  | { type: "theme_set"; name: string }
  | { type: "abort_requested" }
  | { type: "input_changed"; value: string }
  /**
   * Orchestrator acknowledges a chat message submission: we wipe step/feed
   * state for the new turn, keep history and metrics cumulative, and flip
   * to running. The orchestrator is responsible for actually starting the
   * agent turn outside the reducer; the user-bubble is appended by the
   * `user_message` agent event, so the action carries no payload.
   */
  | { type: "message_submitted" }
  /**
   * The operator pressed Enter while a turn was still running. Unlike
   * `message_submitted` this must NOT reset the run state — the turn in
   * flight owns `feed` / `reasoning` / `streamingToolCards` and wiping
   * them mid-run would blank the screen the operator is reading. We only
   * clear the editor and record the message as parked; the orchestrator
   * confirms with `queue_changed` once it has actually buffered it.
   */
  | { type: "message_queued"; text: string }
  /** Orchestrator re-published its pending-message queue (push/drain/clear). */
  | { type: "queue_changed"; queued: readonly string[] }
  /**
   * Flip (or set) what Enter does while a turn is running. `mode`
   * omitted toggles; the persist side-effect lives in the caller, like
   * `theme_set`.
   */
  | { type: "while_busy_mode_changed"; mode?: WhileBusySubmitMode }
  /**
   * The operator submitted a message in `steer` mode. Clears the editor
   * only — the user bubble is appended when the agent loop confirms
   * delivery (`steer_applied`), so a steer that arrives too late and
   * falls back to the queue is not rendered twice.
   */
  | { type: "message_steered"; text: string }
  | { type: "quit_requested" }
  | {
      type: "loaded_skill";
      skill: { name: string; version: string; body: string; loadedAt: number };
    }
  | {
      type: "world_snapshot";
      snapshot: {
        kind: "browser" | "none";
        digest: string;
        text: string;
        capturedAt: number;
      };
    }
  | {
      type: "latest_result";
      result: {
        tool: string;
        status: "ok" | "error";
        summary: string;
        details?: Record<string, unknown>;
      };
    }
  /** Append a delta chunk to the streaming assistant text. */
  | { type: "assistant_delta"; text: string }
  /** Toggle the expanded/collapsed state of a single tool card. */
  | { type: "tool_expand_toggled"; toolCardId: string }
  /** Force-expand or collapse every known tool card at once. */
  | { type: "tool_expand_all_set"; expanded: boolean }
  /** Open the slash palette with a leading-slash query. */
  | { type: "slash_palette_opened"; query: string }
  /** Update the filter query while the palette is open. */
  | { type: "slash_palette_queried"; query: string }
  /** Close the slash palette without committing a selection. */
  | { type: "slash_palette_closed" }
  | { type: "menu_opened" }
  | { type: "menu_closed" }
  | { type: "menu_query_changed"; query: string }
  | { type: "menu_cursor_moved"; delta: number }
  | { type: "menu_cursor_set"; cursor: number }
  | { type: "menu_path_set"; path: string | null }
  /** Move the highlight in the open slash palette by delta rows. */
  | { type: "slash_palette_cursor_moved"; delta: 1 | -1 }
  /** Reset the slash palette highlight to a specific row. */
  | { type: "slash_palette_cursor_set"; row: number }
  /** Navigate input history by delta (up = older, down = newer). */
  | { type: "input_history_navigated"; delta: 1 | -1 }
  /** Clear the chat transcript (slash `/clear`). */
  | { type: "chat_cleared" }
  /** Populate + show the session picker overlay. */
  | { type: "session_picker_opened"; sessions: readonly SessionPickerEntry[] }
  /** Hide the session picker overlay. */
  | { type: "session_picker_closed" }
  /** Move the highlight in the open session picker by delta rows. */
  | { type: "session_picker_cursor_moved"; delta: 1 | -1 }
  /** Put the session picker highlight on an absolute row (mouse click). */
  | { type: "session_picker_cursor_set"; row: number }
  /**
   * Open the interactive theme picker. The reducer seeds the cursor from the
   * current `themeName` and records it in `themePickerOriginal` so Esc can
   * revert the live preview.
   */
  | { type: "theme_picker_opened" }
  /** Close the theme picker (cancel). Caller reverts the preview palette. */
  | { type: "theme_picker_closed" }
  /** Move the theme picker highlight by delta rows (clamped). */
  | { type: "theme_picker_cursor_moved"; delta: 1 | -1 }
  /** Put the theme picker highlight on an absolute row (mouse click). */
  | { type: "theme_picker_cursor_set"; row: number }
  /**
   * Hard-switch the TUI transcript to an already-loaded session. The
   * orchestrator performs the SessionStore load + swap, then dispatches
   * this action so the reducer can rebuild `messages` from stored turns
   * and reset per-run state. The cwd of the picked session is reflected
   * in `session.workingDir` so the header stays accurate.
   */
  | {
      type: "session_switched";
      sessionId: string;
      workingDir: string;
      messages: readonly ChatMessage[];
    }
  /** Header/runtime: user saved a new llama-server base URL (e.g. via /llama). */
  | { type: "llama_url_changed"; url: string }
  /**
   * Result of a single background llama-server `/health` probe. The footer
   * consumes this to render an always-on indicator independent of the
   * Models tab refresh cadence.
   */
  | {
      type: "llm_health_updated";
      status: "probing" | "healthy" | "unreachable" | "error";
      latencyMs: number | null;
      error: string | null;
      checkedAt: number;
    }
  /**
   * Result of a one-shot `/props` probe done by `LlmHealthPoller` after
   * the first healthy `/health`. Updates the active model label shown
   * in the StatusBar without touching the rest of the health slice.
   */
  | {
      type: "llm_model_updated";
      model: string | null;
      /**
       * Physical context window (`n_ctx`) reported by `/props`, or `null`
       * when unknown (older llama.cpp builds, cloud providers, optimistic
       * catalog-label updates before the daemon reports). Omitted updates
       * leave the previous value untouched.
       */
      contextWindow?: number | null;
    }
  /** Refresh the always-on sidebar session list (orchestrator drives the load). */
  | { type: "recent_sessions_updated"; sessions: readonly SessionPickerEntry[] }
  /** Toggle keyboard focus between editor and sidebar. */
  | { type: "chat_focus_toggled" }
  /** Set keyboard focus explicitly (used when the sidebar collapses below the width threshold). */
  | { type: "chat_focus_set"; focus: "editor" | "sidebar" }
  /** Pick which sidebar pane (Sessions / Tasks) is the current Tab-cycle stop. */
  | { type: "sidebar_section_focused"; section: "sessions" | "tasks" }
  /** Move the sidebar's session-list cursor by N rows (clamped). */
  | { type: "sidebar_cursor_moved"; delta: 1 | -1 }
  /** Put the sidebar's session-list cursor on an absolute row (mouse click). */
  | { type: "sidebar_cursor_set"; row: number }
  /** Move the sidebar's tasks-list cursor by N rows (clamped). */
  | { type: "sidebar_tasks_cursor_moved"; delta: 1 | -1 }
  /** Put the sidebar's tasks-list cursor on an absolute row (mouse click). */
  | { type: "sidebar_tasks_cursor_set"; row: number }
  /** Scroll the chat history by N messages (positive = older). Clamped to [0, total]. */
  | { type: "chat_scrolled"; delta: number }
  /** Snap the chat scroll back to the bottom (newest message). */
  | { type: "chat_scroll_reset" }
  /** A newer release was detected at startup; offer the in-app update. */
  | { type: "update_available"; current: string; latest: string }
  /** User declined the update offer (or it was otherwise cleared). */
  | { type: "update_dismissed" }
  /** User accepted: the install script is now running. */
  | { type: "update_started" }
  /** The install script settled. */
  | { type: "update_finished"; ok: boolean; version?: string; error?: string }
  | LocalModelsAction
  | TasksAction
  | SkillsAction
  | MemoryAction
  | McpAction
  | TelegramAction
  | PrivacyAction
  | ProvidersAction
  | LlmPanelAction
  | FallbackPanelAction
  | ImportAction;
