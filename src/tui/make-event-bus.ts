import type { AgentLoopEvent } from "../agent/agent-loop.js";
import type { ApprovalRequest } from "../approval/approval-gate.js";
import type { MetricSample } from "../tracing/metrics-collector.js";
import type { LogRecord } from "../tracing/structured-logger.js";
import type { TuiAction } from "./tui-action.js";
import type { TuiEventBus } from "./tui-app.js";

export interface TuiEventBusEmitter extends TuiEventBus {
  emit(action: TuiAction): void;
  emitAgentEvent(event: AgentLoopEvent): void;
  emitApproval(request: ApprovalRequest): void;
  emitMetric(sample: MetricSample): void;
  emitLog(record: LogRecord): void;
}

/**
 * Tiny in-process pub/sub used by the orchestrator to publish reducer
 * actions to the React tree. Declared outside `tui-app.tsx` so the app
 * shell stays focused on rendering.
 */
export function makeTuiEventBus(): TuiEventBusEmitter {
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
      for (const listener of listeners)
        listener({ type: "approval_requested", request });
    },
    emitMetric(sample) {
      for (const listener of listeners) listener({ type: "metric", sample });
    },
    emitLog(record) {
      for (const listener of listeners) listener({ type: "log", record });
    },
  };
}
