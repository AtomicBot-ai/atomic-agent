import type { ApprovalRequest } from "../approval/approval-gate.js";

/**
 * In-process pub/sub for approval requests. The serve command wires
 * `runtime.handlers.onApprovalRequest` to `ApprovalBus.publish` and any
 * number of subscribers (SSE connections, test probes, loggers) can
 * observe those events via `subscribe`. Single-process, single-writer —
 * approvals do not need cross-worker coordination in atomic-agent.
 */
export type ApprovalListener = (request: ApprovalRequest) => void;

export class ApprovalBus {
  private readonly listeners = new Set<ApprovalListener>();
  private readonly pending = new Map<string, ApprovalRequest>();

  publish(request: ApprovalRequest): void {
    this.pending.set(request.approvalId, request);
    for (const listener of this.listeners) {
      try {
        listener(request);
      } catch {
        // A rogue listener must not take down the agent loop —
        // approval emission is best-effort to consumers.
      }
    }
  }

  /**
   * Called when the agent gate has accepted a decision. Removes the
   * request from the in-memory "pending" mirror so newly-connected
   * subscribers don't see stale prompts.
   */
  resolved(approvalId: string): void {
    this.pending.delete(approvalId);
  }

  subscribe(listener: ApprovalListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): ApprovalRequest[] {
    return Array.from(this.pending.values());
  }
}
