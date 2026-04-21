import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useReducer, type ReactElement } from "react";
import type { AgentLoopEvent } from "../agent/agent-loop.js";
import type { ApprovalRequest } from "../approval/approval-gate.js";
import type { MetricSample } from "../telemetry/metrics-collector.js";
import type { LogRecord } from "../telemetry/structured-logger.js";
import { reduceTuiState, type TuiAction } from "./agent-event-reducer.js";
import { ApprovalModal } from "./approval-modal.js";
import { ChatTab } from "./chat-tab.js";
import { EventFeed } from "./event-feed.js";
import { GoalInput } from "./goal-input.js";
import { APPROVAL_HOTKEYS, IDLE_HOTKEYS, RUNNING_HOTKEYS, cycleTab } from "./hotkeys.js";
import { LogsTab } from "./logs-tab.js";
import { MetricsFooter } from "./metrics-footer.js";
import { ReasoningTab } from "./reasoning-tab.js";
import { SessionHeader } from "./session-header.js";
import {
  canAcceptMessage,
  createInitialTuiState,
  type TuiSessionInfo,
  type TuiState,
} from "./tui-state.js";
import { WorldPanel } from "./world-panel.js";

/**
 * Event bus bridging the agent runtime (imperative, callback-driven) with
 * the reducer (pure). The CLI entry pushes actions into the bus; the
 * `TuiApp` effect subscribes and dispatches them into the reducer on the
 * next React tick.
 */
export interface TuiEventBus {
  subscribe(listener: (action: TuiAction) => void): () => void;
}

export interface TuiAppCallbacks {
  onApprovalDecision(approvalId: string, approved: boolean): void;
  /** Abort the currently running loop (stays in TUI). */
  onAbort(): void;
  /** Fully quit the TUI and shut down the runtime. */
  onQuit(): void;
  /** Submit a new chat message — the orchestrator drives a new turn. */
  onMessageSubmitted(message: string): void;
}

export interface TuiAppProps {
  session: TuiSessionInfo;
  bus: TuiEventBus;
  callbacks: TuiAppCallbacks;
  /** Allow the CLI entry to cap memory / terminal height. */
  maxVisibleRows?: number;
}

const DEFAULT_MAX_VISIBLE_ROWS = 14;

export function TuiApp({
  session,
  bus,
  callbacks,
  maxVisibleRows = DEFAULT_MAX_VISIBLE_ROWS,
}: TuiAppProps): ReactElement {
  const [state, dispatch] = useReducer(reduceTuiState, session, createInitialTuiState);
  const app = useApp();

  useEffect(() => {
    return bus.subscribe((action) => dispatch(action));
  }, [bus]);

  useEffect(() => {
    if (state.status === "quitting") {
      callbacks.onQuit();
      app.exit();
    }
  }, [state.status, callbacks, app]);

  useInput((input, key) => {
    if (state.pendingApproval) {
      handleApprovalInput(input, key, state.pendingApproval, callbacks, dispatch);
      return;
    }
    if (key.ctrl && input === "c") {
      callbacks.onAbort();
      callbacks.onQuit();
      dispatch({ type: "quit_requested" });
      return;
    }
    if (key.escape) {
      if (canAcceptMessage(state)) {
        callbacks.onQuit();
        dispatch({ type: "quit_requested" });
      } else {
        callbacks.onAbort();
        dispatch({ type: "abort_requested" });
      }
      return;
    }
    if (key.tab) {
      dispatch({ type: "tab_changed", tab: cycleTab(state.activeTab) });
      return;
    }
  });

  return (
    <Box flexDirection="column">
      <SessionHeader state={state} />
      {state.pendingApproval ? <ApprovalModal request={state.pendingApproval} /> : null}
      <TabBar state={state} />
      <ActiveTab state={state} maxVisible={maxVisibleRows} />
      <MetricsFooter state={state} />
      <GoalInput
        state={state}
        onChange={(value) => dispatch({ type: "input_changed", value })}
        onSubmit={(value) => {
          dispatch({ type: "message_submitted", message: value });
          callbacks.onMessageSubmitted(value);
        }}
      />
      <HotkeyFooter state={state} />
    </Box>
  );
}

function handleApprovalInput(
  input: string,
  key: { escape?: boolean; ctrl?: boolean },
  request: ApprovalRequest,
  callbacks: TuiAppCallbacks,
  dispatch: (action: TuiAction) => void,
): void {
  const lower = input.toLowerCase();
  if (lower === "y") {
    callbacks.onApprovalDecision(request.approvalId, true);
    dispatch({ type: "approval_resolved", approvalId: request.approvalId, approved: true });
    return;
  }
  if (lower === "n") {
    callbacks.onApprovalDecision(request.approvalId, false);
    dispatch({ type: "approval_resolved", approvalId: request.approvalId, approved: false });
    return;
  }
  if (key.escape || (key.ctrl && input === "c")) {
    callbacks.onApprovalDecision(request.approvalId, false);
    callbacks.onAbort();
    dispatch({ type: "approval_resolved", approvalId: request.approvalId, approved: false });
    dispatch({ type: "abort_requested" });
  }
}

function TabBar({ state }: { state: TuiState }): ReactElement {
  const tabs: Array<{ id: typeof state.activeTab; label: string }> = [
    { id: "chat", label: `Chat${state.messages.length > 0 ? ` (${state.messages.length})` : ""}` },
    { id: "feed", label: "Feed" },
    { id: "world", label: "World" },
    { id: "reasoning", label: `Reasoning${state.reasoning.length > 0 ? ` (${state.reasoning.length})` : ""}` },
    { id: "logs", label: "Logs" },
  ];
  return (
    <Box>
      {tabs.map((tab, idx) => {
        const active = tab.id === state.activeTab;
        return (
          <Text key={tab.id}>
            <Text color={active ? "cyan" : "gray"} bold={active}>
              {active ? "▶ " : "  "}
              {tab.label}
            </Text>
            {idx < tabs.length - 1 ? <Text color="gray">  </Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

function ActiveTab({ state, maxVisible }: { state: TuiState; maxVisible: number }): ReactElement {
  switch (state.activeTab) {
    case "chat":
      return <ChatTab state={state} maxVisible={maxVisible} />;
    case "feed":
      return <EventFeed state={state} maxVisible={maxVisible} />;
    case "world":
      return <WorldPanel state={state} />;
    case "reasoning":
      return <ReasoningTab state={state} maxVisible={maxVisible} />;
    case "logs":
      return <LogsTab state={state} maxVisible={maxVisible} />;
    default:
      return <ChatTab state={state} maxVisible={maxVisible} />;
  }
}

function HotkeyFooter({ state }: { state: TuiState }): ReactElement {
  const hotkeys = state.pendingApproval
    ? APPROVAL_HOTKEYS
    : canAcceptMessage(state)
      ? IDLE_HOTKEYS
      : RUNNING_HOTKEYS;
  return (
    <Box>
      <Text color="gray">
        {hotkeys.map((h) => `[${h.key}] ${h.label}`).join("  ")}
      </Text>
      {state.lastRunStatus ? <Text color="gray">   last: {state.lastRunStatus}</Text> : null}
    </Box>
  );
}

/**
 * Narrow-typed facade the CLI entry uses to feed events into the bus.
 * Kept public so tests can drive the app without mocking ink internals.
 */
export function makeTuiEventBus(): TuiEventBus & {
  emit(action: TuiAction): void;
  emitAgentEvent(event: AgentLoopEvent): void;
  emitApproval(request: ApprovalRequest): void;
  emitMetric(sample: MetricSample): void;
  emitLog(record: LogRecord): void;
} {
  const listeners = new Set<(action: TuiAction) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(action) {
      for (const listener of listeners) listener(action);
    },
    emitAgentEvent(event) {
      for (const listener of listeners) listener({ type: "agent_event", event });
    },
    emitApproval(request) {
      for (const listener of listeners) listener({ type: "approval_requested", request });
    },
    emitMetric(sample) {
      for (const listener of listeners) listener({ type: "metric", sample });
    },
    emitLog(record) {
      for (const listener of listeners) listener({ type: "log", record });
    },
  };
}
