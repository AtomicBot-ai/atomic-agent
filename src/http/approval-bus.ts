import type { ApprovalRequest } from "../approval/approval-gate.js";

/**
 * In-process pub/sub for approval requests. The serve command wires
 * `runtime.handlers.onApprovalRequest` to `ApprovalBus.publish` and any
 * number of subscribers (SSE connections, test probes, loggers) can
 * observe those events via `subscribe`. Single-process, single-writer —
 * approvals do not need cross-worker coordination in atomic-agent.
 */
export type ApprovalListener = (request: ApprovalRequest) => void;

/**
 * ATO-1111: the most requests the pending mirror keeps. Serve prunes it on
 * every publish; this cap is the backstop for a host that never does, so a
 * many-hour session cannot grow it without bound. Oldest goes first. Once a
 * host has pruned, the cap never drops a request the gate still holds: a
 * window reconnecting /api/events would get no card for it and its turn
 * would wait for an answer nobody can give.
 */
export const MAX_MIRRORED_APPROVALS = 100;

export class ApprovalBus {
  private readonly listeners = new Set<ApprovalListener>();
  private readonly pending = new Map<string, ApprovalRequest>();
  /** The last `prune` predicate: what the gate still holds, when the host told us. */
  private isOpen: ((request: ApprovalRequest) => boolean) | null = null;

  publish(request: ApprovalRequest): void {
    this.pending.set(request.approvalId, request);
    if (this.pending.size > MAX_MIRRORED_APPROVALS) this.evictOverCap();
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

  /**
   * Drop every mirrored request `isOpen` says the gate no longer holds.
   * The gate forgets a request by itself when the turn that asked is
   * aborted (client gone, cancel, Stop) and nothing tells the bus, so the
   * mirror kept those requests forever and every `/api/events` reconnect
   * replayed them as live prompts: one more card per dead request, for
   * the same command, in the window that reconnected.
   */
  prune(isOpen: (request: ApprovalRequest) => boolean): void {
    this.isOpen = isOpen;
    for (const [approvalId, request] of this.pending) {
      if (!isOpen(request)) this.pending.delete(approvalId);
    }
  }

  /** Oldest first, skipping every request the gate is known to still hold. */
  private evictOverCap(): void {
    for (const [approvalId, request] of this.pending) {
      if (this.pending.size <= MAX_MIRRORED_APPROVALS) return;
      if (this.isOpen?.(request)) continue;
      this.pending.delete(approvalId);
    }
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
