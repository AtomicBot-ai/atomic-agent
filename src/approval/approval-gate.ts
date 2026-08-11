import { randomUUID } from "node:crypto";
import {
  clampApprovalLevel,
  isAutoApprovedAt,
  MIN_APPROVAL_LEVEL,
  type ApprovalCategory,
  type ApprovalLevel,
} from "./approval-level.js";

export interface ApprovalRequest {
  approvalId: string;
  sessionId: string;
  tool: string;
  /**
   * What kind of action is being gated. Decides whether the current
   * approval level auto-approves the request; call sites categorise
   * because only they know the context (fs tools know the target path,
   * the shell tool knows the guard verdict, and so on).
   */
  category: ApprovalCategory;
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
  private level: ApprovalLevel;

  constructor(options: { emit: ApprovalEmitter; level?: ApprovalLevel }) {
    this.emitter = options.emit;
    this.level = options.level ?? MIN_APPROVAL_LEVEL;
  }

  /**
   * Move the approval level at runtime, in either direction. Out-of-range
   * input is clamped to [1, 5]. Level 1 prompts for every request; level
   * 5 auto-approves everything; levels in between auto-approve by
   * request category (see `approval-level.ts`). Already-pending requests
   * are not resolved retroactively — they still wait for their decision.
   */
  setLevel(level: number): void {
    this.level = clampApprovalLevel(level);
  }

  /** Current approval level (live value, not the constructor arg). */
  getLevel(): ApprovalLevel {
    return this.level;
  }

  request(
    params: Omit<ApprovalRequest, "approvalId"> & { approvalId?: string },
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<ApprovalDecision> {
    const approvalId = params.approvalId ?? randomUUID();
    const request: ApprovalRequest = { ...params, approvalId };
    if (isAutoApprovedAt(this.level, request.category)) {
      return Promise.resolve({
        approvalId,
        approved: true,
        reason: `auto-approved (level ${this.level})`,
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
