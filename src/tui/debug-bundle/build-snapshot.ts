import type {
  ChatMessage,
  FeedEntry,
  ReasoningEntry,
  RollingMetrics,
  RunHistoryEntry,
  TuiSessionInfo,
  TuiState,
  TuiTab,
  TuiUiMode,
} from "../tui-state.js";
import type { LogRecord } from "../../tracing/structured-logger.js";

/**
 * Serializable slice of `TuiState` captured the instant the operator
 * presses the debug-bundle hotkey. We deliberately pick only the
 * plain-data fields so the snapshot survives `JSON.stringify` without
 * circular references or runtime-only handles (approval promises,
 * world snapshots, skill bodies, tasks panel state).
 */
export interface DebugBundleSnapshot {
  session: TuiSessionInfo;
  uiMode: TuiUiMode;
  activeTab: TuiTab;
  lastRunStatus: string | null;
  messages: readonly ChatMessage[];
  feed: readonly FeedEntry[];
  logs: readonly LogRecord[];
  reasoning: readonly ReasoningEntry[];
  runHistory: readonly RunHistoryEntry[];
  metrics: RollingMetrics;
}

export function buildDebugBundleSnapshot(state: TuiState): DebugBundleSnapshot {
  return {
    session: state.session,
    uiMode: state.uiMode,
    activeTab: state.activeTab,
    lastRunStatus: state.lastRunStatus,
    messages: state.messages,
    feed: state.feed,
    logs: state.logs,
    reasoning: state.reasoning,
    runHistory: state.runHistory,
    metrics: state.metrics,
  };
}

/**
 * Filesystem-safe timestamp: ISO 8601 with `:` replaced by `-` so the
 * resulting string is usable as a filename on every platform.
 */
export function debugBundleTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/:/g, "-");
}

export function debugBundleFileName(now: Date = new Date()): string {
  return `atomic-agent-debug-${debugBundleTimestamp(now)}.zip`;
}
