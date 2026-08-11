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
 * On top of the standing approval level, the gate holds in-memory,
 * per-session grant sets ("point exceptions"): approved categories and
 * approved shell command shapes, keyed by the id of the session that
 * granted them. A grant silences its category/shape for the rest of
 * that session without moving the standing level. Because grants are
 * keyed by session id, a request from a different session — a background
 * task turn, a second live session on the same runtime — shares this
 * gate but never rides another session's grant. Grants never persist and
 * never bypass the two hard limits: hardline shell-guard rules block
 * before the gate is ever called, and `trust_config` is never grantable
 * (see `request` / `resolve`).
 */
export class ApprovalGate {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly emitter: ApprovalEmitter;
  private level: ApprovalLevel;
  /**
   * Session grants keyed by the id of the session that made them. A grant
   * is a point exception scoped to *that* session; a request from another
   * session (a background task turn, a second live session) shares this
   * gate but never sees it. This keying is what makes "session-scoped" a
   * structural fact rather than a promise every caller remembers to honour
   * by calling `clearSessionGrants()`.
   */
  private readonly grantsBySession = new Map<
    string,
    { categories: Set<ApprovalCategory>; shapes: Set<string> }
  >();

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
   * Drop session grants. With a `sessionId`, drops only that session's
   * grants; with no argument, drops all of them (the TUI calls the
   * no-arg form on a session switch / new session as a belt-and-braces
   * reset — the per-session keying already isolates other sessions). The
   * standing level is untouched: it is a durable posture, grants are not.
   */
  clearSessionGrants(sessionId?: string): void {
    if (sessionId === undefined) {
      this.grantsBySession.clear();
      return;
    }
    this.grantsBySession.delete(sessionId);
  }

  /**
   * Snapshot of live grants. With a `sessionId`, only that session's
   * grants; with no argument, the union across every session (in a TUI
   * process only the interactive operator ever records grants, so the
   * union is exactly their live set). Diagnostic / UI only.
   */
  sessionGrants(sessionId?: string): SessionGrantsSnapshot {
    if (sessionId !== undefined) {
      const entry = this.grantsBySession.get(sessionId);
      return {
        categories: entry ? [...entry.categories] : [],
        shapes: entry ? [...entry.shapes] : [],
      };
    }
    const categories = new Set<ApprovalCategory>();
    const shapes = new Set<string>();
    for (const entry of this.grantsBySession.values()) {
      for (const category of entry.categories) categories.add(category);
      for (const shape of entry.shapes) shapes.add(shape);
    }
    return { categories: [...categories], shapes: [...shapes] };
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
    const grants = this.grantsBySession.get(request.sessionId);
    if (!grants) return null;
    if (grants.categories.has(request.category)) {
      return "auto-approved (session grant)";
    }
    if (
      request.category === "shell" &&
      request.commandShape &&
      grants.shapes.has(request.commandShape)
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
    const grants = this.grantsForSession(request.sessionId);
    if (scope === "category") {
      grants.categories.add(request.category);
      return;
    }
    if (request.category === "shell" && request.commandShape) {
      grants.shapes.add(request.commandShape);
    }
  }

  /** Get (or lazily create) the grant set for a session id. */
  private grantsForSession(
    sessionId: string,
  ): { categories: Set<ApprovalCategory>; shapes: Set<string> } {
    let entry = this.grantsBySession.get(sessionId);
    if (!entry) {
      entry = { categories: new Set(), shapes: new Set() };
      this.grantsBySession.set(sessionId, entry);
    }
    return entry;
  }

  reject(approvalId: string, reason: string): boolean {
    return this.resolve({ approvalId, approved: false, reason });
  }

  pendingCount(): number {
    return this.pending.size;
  }
}

/**
 * Whether the approval prompt may offer `[s]` (grant the whole category
 * for the session) for this request. Everything is grantable except
 * `trust_config`. Shared by every surface (TUI modal, TUI keys, CLI
 * prompt) so the offer set never drifts between them.
 */
export function canGrantCategory(request: ApprovalRequest): boolean {
  return isGrantableCategory(request.category);
}

/**
 * Whether the prompt may offer `[a]` (grant this shell command shape).
 * Only for a shell request that carries a `commandShape`; the shell tool
 * deliberately withholds the shape for opaque interpreters (`bash -c …`),
 * so `[a]` is never offered where the binary name hides what runs.
 */
export function canGrantShape(request: ApprovalRequest): boolean {
  return request.category === "shell" && Boolean(request.commandShape);
}
