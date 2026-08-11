import { randomUUID } from "node:crypto";
import {
  clampApprovalLevel,
  isAutoApprovedAt,
  isGrantableCategory,
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
  /**
   * Normalised command binary (argv[0]) for `category: "shell"` requests,
   * e.g. `git`. It is the unit a shape grant (`[a]`) covers: "always
   * allow `git` this session". Set only by the shell tool; absent means
   * the shape option is not offered.
   */
  commandShape?: string;
}

/**
 * The scope a caller asks the gate to remember when it approves a
 * request. Absent means "this call only" (`y`); `category` grants the
 * whole `ApprovalCategory` for the session (`s`); `shape` grants the
 * request's `commandShape` binary (`a`, shell only). The gate reads the
 * category/shape from its own pending request, never from the caller:
 * the caller names the scope, not the value, so a host cannot grant a
 * category the prompt was not about.
 */
export type ApprovalGrantScope = "category" | "shape";

export interface ApprovalDecision {
  approvalId: string;
  approved: boolean;
  reason?: string;
  /** Session grant to record alongside an approval. Ignored when denied. */
  grant?: ApprovalGrantScope;
}

export type ApprovalEmitter = (request: ApprovalRequest) => void;

/** A live, in-memory view of a session's point grants. Diagnostic only. */
export interface SessionGrantsSnapshot {
  categories: readonly ApprovalCategory[];
  shapes: readonly string[];
}

export class ApprovalGateError extends Error {
  constructor(
    message: string,
    public readonly approvalId: string,
  ) {
    super(message);
    this.name = "ApprovalGateError";
  }
}

interface PendingEntry {
  resolve: (decision: ApprovalDecision) => void;
  request: ApprovalRequest;
}

/**
 * Single-pending-request approval gate. The agent loop calls `request()`
 * and awaits a decision; the sidecar (or CLI) replies via `resolve()`.
 * Concurrent approvals per session are out of scope — the agent loop is
 * strictly sequential.
 *
 * On top of the standing approval level, the gate holds two in-memory,
 * session-scoped grant sets ("point exceptions"): approved categories
 * and approved shell command shapes. A grant silences its
 * category/shape for the rest of the session without moving the
 * standing level. Grants never persist and never bypass the two hard
 * limits: hardline shell-guard rules block before the gate is ever
 * called, and `trust_config` is never grantable (see `request` /
 * `resolve`).
 */
export class ApprovalGate {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly emitter: ApprovalEmitter;
  private level: ApprovalLevel;
  private readonly grantedCategories = new Set<ApprovalCategory>();
  private readonly grantedShapes = new Set<string>();

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

  /**
   * Drop every session grant. Called when a new session starts so point
   * exceptions never outlive the session that granted them. The standing
   * level is untouched: it is a durable posture, grants are not.
   */
  clearSessionGrants(): void {
    this.grantedCategories.clear();
    this.grantedShapes.clear();
  }

  /** Snapshot of the live grant sets. Diagnostic / UI only. */
  sessionGrants(): SessionGrantsSnapshot {
    return {
      categories: [...this.grantedCategories],
      shapes: [...this.grantedShapes],
    };
  }

  request(
    params: Omit<ApprovalRequest, "approvalId"> & { approvalId?: string },
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<ApprovalDecision> {
    const approvalId = params.approvalId ?? randomUUID();
    const request: ApprovalRequest = { ...params, approvalId };
    const auto = this.autoApproval(request);
    if (auto) return Promise.resolve({ approvalId, approved: true, reason: auto });
    return new Promise<ApprovalDecision>((resolve, reject) => {
      this.pending.set(approvalId, { resolve, request });
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

  /**
   * Decide whether `request` runs without a prompt, and why. The
   * standing level wins first; a session grant is the point exception
   * checked next. `trust_config` is excluded from grants here (it is
   * pinned at level 5 and is the self-escalation surface), so a grant
   * can never silence a config/`.env` write. Returns the reason string
   * on auto-approval, or `null` to prompt.
   */
  private autoApproval(request: ApprovalRequest): string | null {
    if (isAutoApprovedAt(this.level, request.category)) {
      return `auto-approved (level ${this.level})`;
    }
    if (!isGrantableCategory(request.category)) return null;
    if (this.grantedCategories.has(request.category)) {
      return "auto-approved (session grant)";
    }
    if (
      request.category === "shell" &&
      request.commandShape &&
      this.grantedShapes.has(request.commandShape)
    ) {
      return `auto-approved (session grant: ${request.commandShape})`;
    }
    return null;
  }

  resolve(decision: ApprovalDecision): boolean {
    const entry = this.pending.get(decision.approvalId);
    if (!entry) return false;
    this.pending.delete(decision.approvalId);
    if (decision.approved && decision.grant) {
      this.recordGrant(entry.request, decision.grant);
    }
    entry.resolve(decision);
    return true;
  }

  /**
   * Record a session grant from an approved decision. The scope comes
   * from the caller but the value comes from the gate's own pending
   * request. Never grants `trust_config`, the one category that could
   * silently raise trust for the next boot, regardless of what the
   * caller asked; a shape grant needs a `commandShape` on a shell
   * request or it is a no-op.
   */
  private recordGrant(
    request: ApprovalRequest,
    scope: ApprovalGrantScope,
  ): void {
    if (!isGrantableCategory(request.category)) return;
    if (scope === "category") {
      this.grantedCategories.add(request.category);
      return;
    }
    if (request.category === "shell" && request.commandShape) {
      this.grantedShapes.add(request.commandShape);
    }
  }

  reject(approvalId: string, reason: string): boolean {
    return this.resolve({ approvalId, approved: false, reason });
  }

  pendingCount(): number {
    return this.pending.size;
  }
}
