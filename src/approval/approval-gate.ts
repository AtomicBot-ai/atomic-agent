import { randomUUID } from "node:crypto";

export interface ApprovalRequest {
  approvalId: string;
  sessionId: string;
  tool: string;
  reason: string;
  /** Human-readable preview of the action (command, diff snippet, URL, …). */
  preview?: string;
  affectedResources?: string[];
}

export interface ApprovalDecision {
  approvalId: string;
  approved: boolean;
  reason?: string;
}

export type ApprovalEmitter = (request: ApprovalRequest) => void;

export class ApprovalGateError extends Error {
  constructor(
    message: string,
    public readonly approvalId: string,
  ) {
    super(message);
    this.name = "ApprovalGateError";
  }
}

/**
 * Single-pending-request approval gate. The agent loop calls `request()`
 * and awaits a decision; the sidecar (or CLI) replies via `resolve()`.
 * Concurrent approvals per session are out of scope — the agent loop is
 * strictly sequential.
 */
export class ApprovalGate {
  private readonly pending = new Map<
    string,
    (decision: ApprovalDecision) => void
  >();
  private readonly emitter: ApprovalEmitter;
  private autoApprove: boolean;

  constructor(options: { emit: ApprovalEmitter; autoApprove?: boolean }) {
    this.emitter = options.emit;
    this.autoApprove = options.autoApprove ?? false;
  }

  /**
   * Flip auto-approve at runtime. `true` means every subsequent
   * `request()` resolves approved immediately without emitting a prompt;
   * `false` restores interactive approvals. Already-pending requests are
   * not resolved retroactively — they still wait for their decision.
   */
  setAutoApprove(value: boolean): void {
    this.autoApprove = value;
  }

  /** Current auto-approve state (live value, not the constructor arg). */
  isAutoApproveEnabled(): boolean {
    return this.autoApprove;
  }

  request(
    params: Omit<ApprovalRequest, "approvalId"> & { approvalId?: string },
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<ApprovalDecision> {
    const approvalId = params.approvalId ?? randomUUID();
    const request: ApprovalRequest = { ...params, approvalId };
    if (this.autoApprove) {
      return Promise.resolve({
        approvalId,
        approved: true,
        reason: "auto-approved",
      });
    }
    return new Promise<ApprovalDecision>((resolve, reject) => {
      this.pending.set(approvalId, resolve);
      signal?.addEventListener(
        "abort",
        () => {
          this.pending.delete(approvalId);
          reject(
            new ApprovalGateError(
              "approval aborted before a decision was made",
              approvalId,
            ),
          );
        },
        { once: true },
      );
      this.emitter(request);
    });
  }

  resolve(decision: ApprovalDecision): boolean {
    const handler = this.pending.get(decision.approvalId);
    if (!handler) return false;
    this.pending.delete(decision.approvalId);
    handler(decision);
    return true;
  }

  reject(approvalId: string, reason: string): boolean {
    return this.resolve({ approvalId, approved: false, reason });
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
