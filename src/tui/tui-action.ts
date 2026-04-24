import type { AgentLoopEvent } from "../agent/agent-loop.js";
import type { ApprovalRequest } from "../approval/approval-gate.js";
import type { MetricSample } from "../tracing/metrics-collector.js";
import type { LogRecord } from "../tracing/structured-logger.js";
import type { LocalModelsAction } from "./local-models/local-models-actions.js";
import type { TasksAction } from "./tasks/tasks-actions.js";
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
  | { type: "system_message"; text: string }
  | { type: "agent_event"; event: AgentLoopEvent }
  | { type: "approval_requested"; request: ApprovalRequest }
  | { type: "approval_resolved"; approvalId: string; approved: boolean }
  | { type: "metric"; sample: MetricSample }
  | { type: "log"; record: LogRecord }
  | { type: "skill_count_changed"; count: number }
  | { type: "session_created"; sessionId: string }
  | { type: "tab_changed"; tab: TuiTab }
  | { type: "ui_mode_toggled" }
  | { type: "ui_mode_set"; mode: TuiUiMode }
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
  /** Move the highlight in the open slash palette by delta rows. */
  | { type: "slash_palette_cursor_moved"; delta: 1 | -1 }
  /** Reset the slash palette highlight to a specific row. */
  | { type: "slash_palette_cursor_set"; row: number }
  /** Navigate input history by delta (up = older, down = newer). */
  | { type: "input_history_navigated"; delta: 1 | -1 }
  /** Restore the live editor buffer, exiting history navigation. */
  | { type: "input_history_reset" }
  /** Clear the chat transcript (slash `/clear`). */
  | { type: "chat_cleared" }
  /** Populate + show the session picker overlay. */
  | { type: "session_picker_opened"; sessions: readonly SessionPickerEntry[] }
  /** Hide the session picker overlay. */
  | { type: "session_picker_closed" }
  /** Move the highlight in the open session picker by delta rows. */
  | { type: "session_picker_cursor_moved"; delta: 1 | -1 }
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
  | LocalModelsAction
  | TasksAction;
