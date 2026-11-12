import { FanoutScopeRegistry, isInside } from "./fanout-scope.js";
import { ReadScopeGrants } from "./read-scope-grants.js";
import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import {
  currentApprovalLedger,
  recordAutoApproval,
  type ToolApprovalRecord,
} from "./approval-ledger.js";
import {
  clampApprovalLevel,
  formatApprovalCategory,
  isAutoApprovedAt,
  isGrantableCategory,
  MIN_APPROVAL_LEVEL,
  type ApprovalCategory,
  type ApprovalLevel,
} from "./approval-level.js";
import {
  buildAlwaysRule,
  canGrantAlways,
  describeRule,
  matchRules,
  type ApprovalRule,
  type ApprovalRuleDecision,
  type RuleMatch,
} from "./approval-rules.js";
import type { ApprovalRulesSource } from "./approval-rules-store.js";
import { currentApprovalWorkdir } from "./approval-workdir.js";
import {
  isSiteScopedCategory,
  parseSiteGrantKey,
  siteGrantHost,
  siteGrantKey,
  type SiteGrant,
} from "./site-grants.js";
import {
  formatRiskNote,
  isRiskReviewEligible,
  RISK_REVIEW_LOW_REASON,
  runRiskReview,
  type RiskLevel,
  type RiskReviewer,
} from "./risk-review.js";
import {
  formatTaintNote,
  isTaintSensitive,
  TAINT_REVIEW_LOW_REASON,
  UntrustedTaint,
} from "./untrusted-taint.js";

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
  /**
   * The narrower unit a session grant (`s`, scope `category`) covers for
   * this request, when the whole category would be too broad. Set by
   * `os.http.request` to the target's origin (`https://api.example.com`,
   * ATO-1182): "allow for this session" on a POST to one host must not
   * silence a later POST to any other host. With a key, a category grant
   * is remembered for (category, key) only, and only a grant with the
   * same key answers the request; a key-less whole-category grant does
   * not. Absent means the grant covers the whole category, as before.
   */
  grantKey?: string;
  /**
   * Parsed argv of a simple shell command (`["git", "status", "-s"]`),
   * the unit a saved rule's `commandPrefix` matches. Set only by the shell
   * tool, and only where `commandShape` is: a pipeline or a compound line
   * has none, so no prefix rule can match it.
   */
  commandArgv?: string[];
  /**
   * Every simple command the call would run, parsed
   * (`shellRuleSegments`), set even where `commandArgv` is withheld: a
   * dangerous command, a compound line, a binary named by path. Only a
   * saved deny or ask rule reads it, which can only make the call
   * stricter; an allow rule still needs `commandArgv`.
   */
  commandSegments?: string[][];
  /**
   * The call runs a script no rule can read: a shell or interpreter with
   * no script of its own, fed through a pipe, a redirect or a heredoc
   * (`printf 'rm -rf x' | sh`, `shellRunsUnreadableScript`). Only a deny
   * or ask command rule reads it, and it then matches whatever its
   * prefix: what runs could be the very command the rule names.
   */
  commandUnreadable?: boolean;
  /**
   * The session's working directory, for rules scoped to a project. The
   * gate fills it from the dispatching tool call when the tool did not.
   */
  workdir?: string;
  /**
   * Absolute path this request would write, when the host may offer to
   * retarget it before approving (`[e]` in the TUI). Set only by tools
   * whose target is a free choice rather than a file the model just
   * read — currently `os.fs.write`. Absent means "no redirect offered",
   * and a host that ignores the field behaves exactly as before.
   */
  redirectablePath?: string;
  /**
   * Absolute paths of the files this call would replace, move or remove
   * as a whole, when the tool can name them. A file tool sets them only
   * for a whole-file action: `os.fs.write` replacing a file, `os.fs.trash`,
   * `os.fs.restore` — an edit or a patch changes part of a file and names
   * none. A shell command names the files its line writes, redirects
   * into, moves, copies onto or removes (`shellWriteTargets`). Read only
   * by the gate's same-turn rule (`declinedInTurn`): once the user has
   * pressed Deny on a whole-file call, a shell command or another call of
   * the same tool that would change one of its files this turn is the
   * same action by another route.
   */
  targetPaths?: string[];
  /**
   * Set by the gate, never by a caller: what the smart-approval risk
   * review (`risk-review.ts`) said about a request it did not let
   * through, e.g. `risk check: medium (installs a package)`. A surface
   * shows it beside the prompt; absent when no review ran.
   */
  riskNote?: string;
  /** The level behind `riskNote`; absent when the review gave no verdict. */
  riskLevel?: RiskLevel;
}

/**
 * The scope a caller asks the gate to remember when it approves a
 * request. Absent means "this call only" (`y`); `category` grants the
 * whole `ApprovalCategory` for the session (`s`); `shape` grants the
 * request's `commandShape` binary (`a`, shell only). The gate reads the
 * category/shape from its own pending request, never from the caller:
 * the caller names the scope, not the value, so a host cannot grant a
 * category the prompt was not about. `always` saves an allow rule built
 * from the pending request (`buildAlwaysRule`) in the rules store.
 */
export type ApprovalGrantScope = "category" | "shape" | "always";

export interface ApprovalDecision {
  approvalId: string;
  approved: boolean;
  /**
   * On a denial by a person, their own words if they typed any (a
   * surface with only a Deny button leaves it unset — a tag such as
   * "tui-denied" would reach the model as something the user said). On
   * an `automatic` denial, the system's explanation; with
   * `declinedEarlier`, what the user declined ("this same call").
   */
  reason?: string;
  /**
   * True when no person made this decision: a session refuse policy, a
   * prompt that timed out or could not be delivered, one dropped because
   * its surface stopped watching the session. The model is told the user
   * declined only when this is unset (see `describeApprovalDenial`).
   */
  automatic?: boolean;
  /**
   * Set with `automatic` when the gate refused the call because the user
   * already declined it, or a call changing the same file, earlier in
   * this turn (`declinedInTurn`). Nobody decided on this call, but a
   * user's no stands behind it: callers report it as the user's
   * decision, not a system refusal (`describeApprovalDenial`).
   */
  declinedEarlier?: boolean;
  /** Session grant to record alongside an approval. Ignored when denied. */
  grant?: ApprovalGrantScope;
  /**
   * Operator-supplied replacement for the request's `redirectablePath`,
   * approved along with the call. The gate passes it through untouched:
   * it is the *tool* that resolves it, re-categorises it, and decides
   * whether the new target needs another prompt — the gate never lets a
   * decision widen the scope it was asked about. Ignored when denied,
   * and by every tool that did not set `redirectablePath`.
   */
  pathOverride?: string;
}

export type ApprovalEmitter = (request: ApprovalRequest) => void;

/**
 * What the gate does for a session's request that would otherwise
 * prompt. `refuse` resolves it denied with `reason`, emitting nothing:
 * for a session with nobody at the other end of a prompt (a fusion
 * worker — the operator's surface is showing the parent session), where
 * parking the turn on an unanswerable question would hold it until the
 * process exits. Auto-approval still wins first: a level or a grant that
 * would run the call without asking still runs it.
 */
/** The fields of a request a saved rule can read. */
export type RuleCheck = Pick<
  ApprovalRequest,
  | "sessionId"
  | "tool"
  | "category"
  | "commandArgv"
  | "commandSegments"
  | "commandUnreadable"
  | "targetPaths"
  | "affectedResources"
  | "workdir"
>;

export interface SessionApprovalPolicy {
  onPrompt: "refuse";
  reason: string;
  /**
   * A refusal worded for this request, when the session's general
   * `reason` would send the model the wrong way: a fusion worker told to
   * re-delegate a step no fan-out can authorise (`rm -rf`, the agent's
   * own `.env`) loops. `undefined` falls back to `reason`.
   */
  reasonFor?: (request: ApprovalRequest) => string | undefined;
  /**
   * The folder saved rules are matched against for this session, when it
   * is not the session's own: a fusion worker in a throwaway worktree is
   * still working on its parent's project.
   */
  ruleWorkdir?: string;
}

/** A live, in-memory view of a session's point grants. Diagnostic only. */
export interface SessionGrantsSnapshot {
  categories: readonly ApprovalCategory[];
  shapes: readonly string[];
  /**
   * Per-site browser grants (`site-grants.ts`, ATO-1181); present only
   * when there is at least one.
   */
  sites?: readonly SiteGrant[];
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

/**
 * What the user pressed Deny on in a session's current turn. `calls`
 * holds the `callKey` of every such call; `targets` maps each file a
 * whole-file call among them would have changed (`targetPaths`) to its
 * tool.
 */
interface DeclinedInTurn {
  calls: Set<string>;
  targets: Map<string, string>;
}

/** The parts of a request the same-turn target rule reads. */
type TargetQuery = Pick<
  ApprovalRequest,
  "sessionId" | "tool" | "category" | "targetPaths"
>;

interface PendingEntry {
  resolve: (decision: ApprovalDecision) => void;
  request: ApprovalRequest;
  /**
   * Detaches the caller's abort listener. `{ once: true }` only fires —
   * and so only self-removes — when the signal actually aborts, which
   * never happens on the normal approve/deny path. Without this the
   * listener stays attached to a signal that lives for the whole turn,
   * so every gated tool call in a turn leaks one listener plus the
   * closure over its `request` (which carries the command preview).
   */
  detach: () => void;
  /**
   * The ledger of the tool call that asked (see `approval-ledger.ts`),
   * captured in the caller's async context when the prompt goes out. The
   * verdict is written to it on `resolve`, so the transcript can say where
   * in the turn the operator was asked and what they answered.
   */
  ledger: ToolApprovalRecord[] | undefined;
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
    {
      categories: Set<ApprovalCategory>;
      shapes: Set<string>;
      sites: Set<string>;
      /** Category grants narrowed by `grantKey`, see `scopedGrantId`. */
      scoped: Set<string>;
    }
  >();
  /** Per-session prompt policies, keyed like the grants. See `SessionApprovalPolicy`. */
  private readonly policiesBySession = new Map<string, SessionApprovalPolicy>();
  /**
   * What the user declined in each session's current turn, keyed like
   * the grants and emptied when the next turn starts — see
   * `forgetDeclined`. A model told "the user declined" still asked for
   * the same write three more times and then tried it through the shell
   * (ATO-225); the human was asked every time. A repeat is now refused
   * here, without a prompt.
   */
  private readonly declinedBySession = new Map<string, DeclinedInTurn>();
  /**
   * Fusion worker session → the orchestrator session it works for (see
   * `followDeclined`): a worker's calls are refused over what the user
   * declined on the parent's turn too, so re-delegating a declined write
   * is not the way round it.
   */
  private readonly declinedParentBySession = new Map<string, string>();

  /**
   * Directories a session may write in without asking — see
   * `fanout-scope.ts`. Lives on the gate because every caller that can
   * ask for an approval already holds the gate, so nothing new has to be
   * threaded through the fs tools to reach it.
   *
   * Read by `requireFsApproval`, not by `request()`: the scope is about
   * paths, and paths are known one layer up, where the fs funnel has
   * already resolved them.
   */
  readonly fanoutScopes = new FanoutScopeRegistry();

  /**
   * Directories a session may read in without asking again — the `y`
   * of an `fs_read_outside` prompt, remembered per session (see
   * `read-scope-grants.ts`). A session grant in every sense but its
   * unit (a path, not a category), so it lives here and is dropped by
   * `clearSessionGrants` with the rest.
   */
  readonly readScopeGrants = new ReadScopeGrants();

  /** Saved allow / ask / deny rules (`approval-rules.ts`); none until `setRules`. */
  private rules: ApprovalRulesSource | undefined;
  /** The rule the last `grant: "always"` saved, for the host that asked. */
  private lastAlwaysRule: { approvalId: string; rule: ApprovalRule } | null = null;
  /** Smart approval (step 7 of `request`); unset = never consulted. */
  private riskReviewer: RiskReviewer | undefined;
  /** Requests on their way back into `request` after a review (see `requestAfterReview`). */
  private readonly riskReviewed = new Set<string>();
  /** Which sessions read outside content this turn (`untrusted-taint.ts`, ATO-618). */
  private readonly taint = new UntrustedTaint();
  /** Approval ids re-entering `request` after the taint check: no silent approval. */
  private readonly taintHeld = new Set<string>();
  /** `agent.taintReview`, read live; off until bootstrap wires it. */
  private taintReview: () => boolean = () => false;

  constructor(options: { emit: ApprovalEmitter; level?: ApprovalLevel }) {
    this.emitter = options.emit;
    this.level = options.level ?? MIN_APPROVAL_LEVEL;
  }

  /**
   * Install a prompt policy for `sessionId`. Applies only to requests
   * from that session, and only to the ones auto-approval does not
   * already settle. Replaces any earlier policy for the session.
   */
  setSessionPolicy(sessionId: string, policy: SessionApprovalPolicy): void {
    this.policiesBySession.set(sessionId, policy);
  }

  /** Install (or with `undefined`, remove) the saved approval rules. */
  setRules(store: ApprovalRulesSource | undefined): void {
    this.rules = store;
  }

  /** The installed rules store, for hosts that list or delete rules. */
  getRules(): ApprovalRulesSource | undefined {
    return this.rules;
  }

  /** `canGrantAlways` plus: a rules store is installed to save the rule in. */
  canGrantAlways(request: ApprovalRequest): boolean {
    return this.rules !== undefined && canGrantAlways(request);
  }

  /** The rule `resolve({ grant: "always" })` saved for `approvalId`, once. */
  takeAlwaysRule(approvalId: string): ApprovalRule | null {
    const last = this.lastAlwaysRule;
    if (last === null || last.approvalId !== approvalId) return null;
    this.lastAlwaysRule = null;
    return last.rule;
  }

  /**
   * Install (or with `undefined` remove) the smart-approval reviewer. It
   * is asked only about a request that would otherwise prompt, of a
   * grantable category (`isRiskReviewEligible`), from a session with no
   * prompt policy; its own `enabled()` is the live on/off switch.
   */
  setRiskReviewer(reviewer: RiskReviewer | undefined): void {
    this.riskReviewer = reviewer;
  }

  /**
   * Live switch for the review after outside content (`agent.taintReview`,
   * ATO-618). While it returns true, a request the level or a session
   * grant would run silently, of a category `isTaintSensitive` names, on
   * a session that read outside content this turn, goes to the risk
   * reviewer and then the person instead.
   */
  setTaintReview(enabled: () => boolean): void {
    this.taintReview = enabled;
  }

  /** Record that `sessionId` read outside content (`source`) in its running turn. */
  noteUntrustedContent(sessionId: string, source: string): void {
    this.taint.mark(sessionId, source);
  }

  /** Forget the outside content of `sessionId`'s last turn; called when a turn starts. */
  clearUntrustedContent(sessionId: string): void {
    this.taint.clear(sessionId);
  }

  /** Remove the session's policy so its requests prompt again. */
  clearSessionPolicy(sessionId: string): void {
    this.policiesBySession.delete(sessionId);
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
   * What the session's user declined this turn (`declinedInTurn`), and a
   * worker's link to its parent's (`followDeclined`), go with them.
   */
  clearSessionGrants(sessionId?: string): void {
    this.readScopeGrants.clear(sessionId);
    if (sessionId === undefined) {
      this.grantsBySession.clear();
      this.declinedBySession.clear();
      this.declinedParentBySession.clear();
      return;
    }
    this.grantsBySession.delete(sessionId);
    this.declinedBySession.delete(sessionId);
    this.declinedParentBySession.delete(sessionId);
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
      return withSites(
        {
          categories: entry ? [...entry.categories] : [],
          shapes: entry ? [...entry.shapes] : [],
        },
        entry?.sites ?? new Set(),
      );
    }
    const categories = new Set<ApprovalCategory>();
    const shapes = new Set<string>();
    const sites = new Set<string>();
    for (const entry of this.grantsBySession.values()) {
      for (const category of entry.categories) categories.add(category);
      for (const shape of entry.shapes) shapes.add(shape);
      for (const site of entry.sites) sites.add(site);
    }
    return withSites({ categories: [...categories], shapes: [...shapes] }, sites);
  }

  request(
    params: Omit<ApprovalRequest, "approvalId"> & { approvalId?: string },
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<ApprovalDecision> {
    const approvalId = params.approvalId ?? randomUUID();
    const workdir = params.workdir ?? currentApprovalWorkdir();
    const request: ApprovalRequest = {
      ...params,
      approvalId,
      ...(workdir !== undefined ? { workdir } : {}),
    };
    // Before auto-approval: a level or a grant that would run a write
    // silently must not become the way round the user's own Deny of it
    // a few steps earlier.
    const declined = this.declinedInTurn(request);
    if (declined !== null) {
      return Promise.resolve({
        approvalId,
        approved: false,
        reason: declined,
        automatic: true,
        declinedEarlier: true,
      });
    }
    // Saved rules: a deny wins over everything below; an ask skips the
    // level and the grants; an allow is the last way round a prompt.
    const rule = this.matchRule(request);
    if (rule?.decision === "deny") {
      return Promise.resolve({
        approvalId,
        approved: false,
        reason:
          `blocked by your rule ${rule.rule.id}: ${describeRule(rule.rule)}` +
          (request.commandUnreadable === true
            ? " (the command runs a script fed to a shell or interpreter, which a rule cannot read)"
            : ""),
        automatic: true,
      });
    }
    const auto =
      rule?.decision === "ask" || this.taintHeld.has(approvalId)
        ? null
        : this.autoApproval(request);
    if (auto) {
      // After outside content, a risky action is not run silently
      // (ATO-618). A saved allow rule is the person's own narrow choice
      // and still answers, so the hold only stands in for level and grant.
      const sources = rule?.decision === "allow" ? null : this.taintedSources(request);
      if (sources !== null) return this.requestAfterTaint(request, sources, signal);
      // A grant is logged for the turn summary; the standing level is not.
      if (!isAutoApprovedAt(this.level, request.category)) {
        recordAutoApproval("grant", request.category, auto.replace(/^auto-approved \((.*)\)$/, "$1"));
      }
      return Promise.resolve({ approvalId, approved: true, reason: auto });
    }
    if (rule?.decision === "allow") {
      recordAutoApproval(
        "rule",
        request.category,
        `rule ${rule.rule.id}: ${describeRule(rule.rule)}`,
      );
      return Promise.resolve({
        approvalId,
        approved: true,
        reason: `auto-approved (rule ${rule.rule.id})`,
      });
    }
    // An "ask" rule means the person wants the prompt: no model rates it away.
    if (rule?.decision !== "ask" && this.shouldReviewRisk(request)) {
      return this.requestAfterReview(request, signal);
    }
    // Would prompt from here on. A session under a refuse policy gets its
    // denial now, and no emitter ever sees the request — there is no
    // surface that could answer it.
    const policy = this.policiesBySession.get(request.sessionId);
    if (policy?.onPrompt === "refuse") {
      return Promise.resolve({
        approvalId,
        approved: false,
        reason: policy.reasonFor?.(request) ?? policy.reason,
        automatic: true,
      });
    }
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(approvalId);
        reject(
          new ApprovalGateError(
            "approval aborted before a decision was made",
            approvalId,
          ),
        );
      };
      const detach = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      this.pending.set(approvalId, {
        resolve,
        request,
        detach,
        ledger: currentApprovalLedger(),
      });
      // An already-aborted signal never fires `abort`, so check before
      // subscribing rather than hanging until the turn is torn down.
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.emitter(request);
    });
  }

  /**
   * Whether smart approval rates `request` before it prompts. Not for a
   * session under a prompt policy (a fusion worker): nobody would see
   * what the reviewer let through, and its refusal posture stays.
   */
  private shouldReviewRisk(request: ApprovalRequest): boolean {
    const reviewer = this.riskReviewer;
    if (reviewer === undefined || reviewer.enabled?.() === false) return false;
    if (this.riskReviewed.has(request.approvalId)) return false;
    if (this.policiesBySession.has(request.sessionId)) return false;
    return isRiskReviewEligible(request.category);
  }

  /**
   * Step 7: a `low` verdict approves; anything else, a failure included,
   * goes back through `request` (which re-reads the turn's declines and
   * the level, since the review took time) and prompts with the verdict
   * in `riskNote`.
   */
  private async requestAfterReview(
    request: ApprovalRequest,
    signal: AbortSignal | undefined,
  ): Promise<ApprovalDecision> {
    const reviewer = this.riskReviewer;
    const verdict =
      reviewer === undefined
        ? null
        : await runRiskReview(reviewer, { request }, signal ? { signal } : {});
    if (signal?.aborted) {
      throw new ApprovalGateError(
        "approval aborted before a decision was made",
        request.approvalId,
      );
    }
    if (verdict?.risk === "low") {
      recordAutoApproval(
        "risk-review",
        request.category,
        verdict.reason.length > 0 ? `risk review: low (${verdict.reason})` : "risk review: low",
      );
      return {
        approvalId: request.approvalId,
        approved: true,
        reason: RISK_REVIEW_LOW_REASON,
      };
    }
    this.riskReviewed.add(request.approvalId);
    try {
      return this.request(
        {
          ...request,
          riskNote: formatRiskNote(verdict),
          ...(verdict !== null ? { riskLevel: verdict.risk } : {}),
        },
        signal ? { signal } : {},
      );
    } finally {
      this.riskReviewed.delete(request.approvalId);
    }
  }

  /** The outside sources that hold `request` back, or `null` to let the auto-approval stand. */
  private taintedSources(request: ApprovalRequest): readonly string[] | null {
    if (!isTaintSensitive(request.category) || !this.taintReview()) return null;
    const sources = this.taint.sources(request.sessionId);
    return sources.length > 0 ? sources : null;
  }

  /**
   * A request held after outside content: the reviewer (when on, and the
   * category is one it may settle) is asked whether the action serves the
   * user's request; `low` runs it, anything else and every failure puts it
   * to the person, skipping the level and grants. A session under a refuse
   * policy gets its refusal, as for any prompt.
   */
  private async requestAfterTaint(
    request: ApprovalRequest,
    sources: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<ApprovalDecision> {
    const reviewer = this.riskReviewer;
    let consulted = false;
    let verdict: Awaited<ReturnType<typeof runRiskReview>> = null;
    if (
      reviewer !== undefined &&
      reviewer.enabled?.() !== false &&
      isRiskReviewEligible(request.category) &&
      !this.policiesBySession.has(request.sessionId)
    ) {
      consulted = true;
      verdict = await runRiskReview(
        reviewer,
        { request, externalSources: sources },
        signal ? { signal } : {},
      );
    }
    if (signal?.aborted) {
      throw new ApprovalGateError(
        "approval aborted before a decision was made",
        request.approvalId,
      );
    }
    if (verdict?.risk === "low") {
      recordAutoApproval(
        "risk-review",
        request.category,
        verdict.reason.length > 0
          ? `risk review after outside content: low (${verdict.reason})`
          : "risk review after outside content: low",
      );
      return {
        approvalId: request.approvalId,
        approved: true,
        reason: TAINT_REVIEW_LOW_REASON,
      };
    }
    this.taintHeld.add(request.approvalId);
    this.riskReviewed.add(request.approvalId);
    try {
      return this.request(
        {
          ...request,
          riskNote: formatTaintNote(sources, consulted ? formatRiskNote(verdict) : null),
          ...(verdict !== null ? { riskLevel: verdict.risk } : {}),
        },
        signal ? { signal } : {},
      );
    } finally {
      this.taintHeld.delete(request.approvalId);
      this.riskReviewed.delete(request.approvalId);
    }
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
    // A browser submit / off-site grant covers the one site it was made
    // on, never the whole category (ATO-1181).
    if (isSiteScopedCategory(request.category)) {
      const host = siteGrantHost(request);
      return host !== null && grants.sites.has(siteGrantKey(request.category, host))
        ? `auto-approved (session grant: ${host})`
        : null;
    }
    if (request.grantKey !== undefined) {
      // A keyed request (an HTTP call to one origin) is answered only by
      // a grant for the same key, never by a whole-category grant.
      if (grants.scoped.has(scopedGrantId(request.category, request.grantKey))) {
        return `auto-approved (session grant: ${request.grantKey})`;
      }
      return null;
    }
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

  /**
   * The saved rule that decides `request`: the global file's rules plus
   * the ask / deny rules of the session's project file. A store that
   * cannot be read never blocks a request; it is as if it had no rules.
   */
  private matchRule(request: RuleCheck): RuleMatch | null {
    const store = this.rules;
    if (store === undefined) return null;
    try {
      const folder =
        this.policiesBySession.get(request.sessionId)?.ruleWorkdir ?? request.workdir;
      const workdir =
        folder === undefined
          ? undefined
          : (store.canonicalDir?.(folder) ?? resolvePath(folder));
      const rules = [
        ...store.list(),
        ...(workdir !== undefined ? (store.projectRules?.(workdir) ?? []) : []),
      ];
      if (rules.length === 0) return null;
      return matchRules(rules, request, workdir !== undefined ? { workdir } : {});
    } catch {
      return null;
    }
  }

  /**
   * What a saved rule says about a call that may never reach `request`:
   * a fan-out scope returns before the gate, and a deny or ask rule has
   * to stop that shortcut. Asks nothing and records nothing.
   */
  ruleDecisionFor(check: RuleCheck): ApprovalRuleDecision | null {
    const workdir = check.workdir ?? currentApprovalWorkdir();
    return (
      this.matchRule({ ...check, ...(workdir !== undefined ? { workdir } : {}) })
        ?.decision ?? null
    );
  }

  /**
   * Whether `request` repeats something the user declined earlier in
   * this turn, and if so what they declined (the refusal's `reason`).
   * Only a bare Deny counts (`recordDeclined`), and two matches:
   *
   *  - the same call: same tool, category, reason, preview and
   *    resources (`callKey`);
   *  - the same file by another route: a shell command, or another call
   *    of the same tool, that would change a file a whole-file call the
   *    user declined would have changed — the `printf … > test10.txt`
   *    after a denied `os.fs.write test10.txt`, or that write again with
   *    other content. An edit or a patch names no target, so a different
   *    edit of the file asks again: a no to one hunk is not a no to the
   *    file. Nor is a denied shell command a no to its targets: its
   *    redirects are a side of what it was for, and a no to
   *    `npm test > out.log` is not a no to every later write of out.log.
   *
   * Nothing else matches. A call the gate cannot tie to a declined one
   * (a target it cannot name, a different command) still asks the user:
   * a false refusal costs more than one more question.
   */
  private declinedInTurn(request: ApprovalRequest): string | null {
    const key = callKey(request);
    for (const declined of this.declinedRecords(request.sessionId)) {
      if (declined.calls.has(key)) return "this same call";
    }
    return this.declinedTarget(request);
  }

  /**
   * The target rule of `declinedInTurn` on its own: what the user
   * declined that `query` would change by another route, or `null`.
   */
  private declinedTarget(query: TargetQuery): string | null {
    const targets = normaliseTargets(query.targetPaths);
    if (targets.length === 0) return null;
    for (const declined of this.declinedRecords(query.sessionId)) {
      for (const target of targets) {
        const tool = declined.targets.get(target);
        if (
          tool !== undefined &&
          (isShellCommandCategory(query.category) || tool === query.tool)
        ) {
          return `${tool} on ${target} (this call would change that file too)`;
        }
      }
    }
    return null;
  }

  /** The session's own record, then the one of the session it works for. */
  private declinedRecords(sessionId: string): DeclinedInTurn[] {
    const records: DeclinedInTurn[] = [];
    const own = this.declinedBySession.get(sessionId);
    if (own !== undefined) records.push(own);
    const parent = this.declinedParentBySession.get(sessionId);
    const inherited =
      parent === undefined ? undefined : this.declinedBySession.get(parent);
    if (inherited !== undefined) records.push(inherited);
    return records;
  }

  /**
   * Remember a bare Deny, for `declinedInTurn`. A typed reply is left
   * out: its words reach the model as a steer the loop only drains at
   * the next step, and "yes, go ahead" or "put it in ~/Documents" can
   * make the very next call the thing the user asked for.
   */
  private recordDeclined(request: ApprovalRequest, reason?: string): void {
    if ((reason?.trim() ?? "") !== "") return;
    let declined = this.declinedBySession.get(request.sessionId);
    if (declined === undefined) {
      declined = { calls: new Set(), targets: new Map() };
      this.declinedBySession.set(request.sessionId, declined);
    }
    declined.calls.add(callKey(request));
    if (isShellCommandCategory(request.category)) return;
    for (const target of normaliseTargets(request.targetPaths)) {
      declined.targets.set(target, request.tool);
    }
  }

  /**
   * Whether the gate would refuse `query` because the user declined a
   * file it would change earlier in this turn (`declinedInTurn`'s target
   * rule). For callers that would otherwise run it without asking — a
   * fusion worker inside its fan-out's directory — so that the call
   * reaches the gate, which refuses it.
   */
  hasDeclinedTarget(query: TargetQuery): boolean {
    return this.declinedTarget(query) !== null;
  }

  /**
   * Whether the user declined a whole-file call this turn on a file
   * under one of `dirs`. A fan-out into those directories would let its
   * workers write the file unasked, so `fusion.delegate` asks again
   * rather than ride the turn's standing yes.
   */
  hasDeclinedUnder(sessionId: string, dirs: readonly string[]): boolean {
    const declined = this.declinedBySession.get(sessionId);
    if (declined === undefined) return false;
    return [...declined.targets.keys()].some((target) =>
      dirs.some((dir) => isInside(resolvePath(dir), target)),
    );
  }

  /**
   * Forget the files under `dirs` the user declined on `sessionId`:
   * they have since answered yes to a fan-out writing there, asked
   * knowing what they had declined, and that is the newer answer.
   */
  forgetDeclinedUnder(sessionId: string, dirs: readonly string[]): void {
    const declined = this.declinedBySession.get(sessionId);
    if (declined === undefined) return;
    for (const target of [...declined.targets.keys()]) {
      if (dirs.some((dir) => isInside(resolvePath(dir), target))) {
        declined.targets.delete(target);
      }
    }
  }

  /**
   * Hold `sessionId` (a fusion worker) to what the user declined on
   * `parentSessionId` (its orchestrator) in the current turn, until
   * `clearSessionGrants(sessionId)`.
   */
  followDeclined(sessionId: string, parentSessionId: string): void {
    this.declinedParentBySession.set(sessionId, parentSessionId);
  }

  /**
   * Whether a request of `category` from `sessionId` would be put to a
   * person now, in the order `request` decides it: a saved deny or allow
   * rule settles it without a person; an ask rule puts it to one
   * whatever the level or a grant says; otherwise neither the level nor
   * a grant settles it, and no refuse policy answers for the session.
   * `check` names the call for the rules (tool, resources, command);
   * without it only rules that name no tool or command can match.
   * Asks nothing and records nothing (ATO-1270).
   */
  wouldPrompt(
    sessionId: string,
    category: ApprovalCategory,
    check: Partial<Omit<RuleCheck, "sessionId" | "category">> = {},
  ): boolean {
    const workdir = check.workdir ?? currentApprovalWorkdir();
    const rule = this.matchRule({
      tool: "",
      ...check,
      sessionId,
      category,
      ...(workdir !== undefined ? { workdir } : {}),
    });
    if (rule?.decision === "deny" || rule?.decision === "allow") return false;
    if (rule?.decision !== "ask") {
      const probe = {
        approvalId: "",
        sessionId,
        tool: check.tool ?? "",
        category,
        reason: "",
      };
      if (this.autoApproval(probe) !== null) return false;
    }
    return this.policiesBySession.get(sessionId)?.onPrompt !== "refuse";
  }

  /**
   * Forget what the user declined on `sessionId`. Called when a turn
   * starts and when the user steers a running one: what they say next is
   * a new answer, and the same call may be exactly what they now want.
   */
  forgetDeclined(sessionId: string): void {
    this.declinedBySession.delete(sessionId);
  }

  resolve(decision: ApprovalDecision): boolean {
    const entry = this.pending.get(decision.approvalId);
    if (!entry) return false;
    this.pending.delete(decision.approvalId);
    entry.detach();
    entry.ledger?.push({
      verdict: decision.approved ? "approved" : "denied",
      category: entry.request.category,
      at: Date.now(),
    });
    if (decision.approved && decision.grant) {
      this.recordGrant(entry.request, decision.grant);
    }
    // Only a person's no: a timeout or a dropped prompt is nobody's
    // decision, and must not stop the model asking again.
    if (!decision.approved && decision.automatic !== true) {
      this.recordDeclined(entry.request, decision.reason);
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
    if (scope === "always") {
      this.saveAlwaysRule(request);
      return;
    }
    if (scope === "category" && isSiteScopedCategory(request.category)) {
      // Per site (ATO-1181); a request naming no single host stays a
      // one-off, and `canGrantCategory` does not offer it.
      const host = siteGrantHost(request);
      if (host !== null) {
        this.grantsForSession(request.sessionId).sites.add(
          siteGrantKey(request.category, host),
        );
      }
      return;
    }
    const grants = this.grantsForSession(request.sessionId);
    if (scope === "category") {
      if (request.grantKey !== undefined) {
        grants.scoped.add(scopedGrantId(request.category, request.grantKey));
        return;
      }
      grants.categories.add(request.category);
      return;
    }
    if (request.category === "shell" && request.commandShape) {
      grants.shapes.add(request.commandShape);
    }
  }

  /**
   * Save the allow rule "Allow always" stands for, built from the pending
   * request and scoped to its project. Without a store, or when the rule
   * cannot be built or written, the approval stays a one-off.
   */
  private saveAlwaysRule(request: ApprovalRequest): void {
    const store = this.rules;
    if (store === undefined || request.workdir === undefined) return;
    const project = store.canonicalDir?.(request.workdir) ?? resolvePath(request.workdir);
    const rule = buildAlwaysRule(request, project);
    if (rule === null) return;
    try {
      this.lastAlwaysRule = { approvalId: request.approvalId, rule: store.add(rule) };
    } catch {
      // Not saved: this call still runs, the next one asks again.
    }
  }

  /** Get (or lazily create) the grant set for a session id. */
  private grantsForSession(sessionId: string): {
    categories: Set<ApprovalCategory>;
    shapes: Set<string>;
    sites: Set<string>;
    scoped: Set<string>;
  } {
    let entry = this.grantsBySession.get(sessionId);
    if (!entry) {
      entry = { categories: new Set(), shapes: new Set(), sites: new Set(), scoped: new Set() };
      this.grantsBySession.set(sessionId, entry);
    }
    return entry;
  }

  /** A person's denial; `reason` is what they said (see `ApprovalDecision`). */
  reject(approvalId: string, reason: string): boolean {
    return this.resolve({ approvalId, approved: false, reason });
  }

  /**
   * Deny every request `sessionId` has pending, with `reason` as the
   * decision reason the blocked tool call reports back to the model.
   *
   * For hosts whose approval surface stops watching a session while a
   * turn keeps running on it — the TUI switching threads mid-turn is the
   * case in point. An unresolved request would park that turn forever on
   * `await request()`: nobody is left to answer, and the per-session
   * FIFO would hold the session busy until process exit. Denying with an
   * explicit reason is the same shape as the Telegram bridge's auto-deny
   * timeout: the turn continues, the transcript says why.
   *
   * Returns how many requests were denied so the caller can tell the
   * operator what switching away did.
   */
  denyPendingForSession(sessionId: string, reason: string): number {
    const ids: string[] = [];
    for (const [approvalId, entry] of this.pending) {
      if (entry.request.sessionId === sessionId) ids.push(approvalId);
    }
    // Nobody answered these, so they are not the user's decision.
    for (const approvalId of ids) {
      this.resolve({ approvalId, approved: false, reason, automatic: true });
    }
    return ids.length;
  }

  /**
   * The request `sessionId` is currently parked on, if any.
   *
   * For hosts whose approval surface follows the visible session: a
   * request raised by an off-screen session is only *pointed at* there
   * (answering keys must never act across sessions), so when the
   * operator navigates into the owning session the host needs the
   * original request back to re-raise the prompt. At most one request
   * is pending per session by design, so first match is the match.
   */
  pendingRequestForSession(sessionId: string): ApprovalRequest | null {
    for (const entry of this.pending.values()) {
      if (entry.request.sessionId === sessionId) return entry.request;
    }
    return null;
  }

  /**
   * The request `approvalId` is parked on, or `null` once it is resolved
   * or dropped. For a host that must check what a decision may grant
   * before it sends one: the HTTP route offers "allow in this chat" only
   * where the request carries a shape (`canGrantShape`).
   */
  pendingRequest(approvalId: string): ApprovalRequest | null {
    return this.pending.get(approvalId)?.request ?? null;
  }

  /**
   * Whether `approvalId` still waits for a decision here. False once it
   * is resolved, or dropped because the turn that asked was aborted. A
   * session can hold more than one request at a time (calls of different
   * resource classes in one batch run concurrently), so a host mirroring
   * requests checks by id, not by `pendingRequestForSession`.
   */
  isPending(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }

  pendingCount(): number {
    return this.pending.size;
  }
}

/**
 * The id a key-narrowed category grant is stored under. NUL cannot occur
 * in a category name or an origin, so two pairs never collide.
 */
function scopedGrantId(category: ApprovalCategory, key: string): string {
  return `${category}\u0000${key}`;
}

/**
 * Whether the approval prompt may offer `[s]` (grant the whole category
 * for the session) for this request. Everything is grantable except
 * `trust_config`. Shared by every surface (TUI modal, TUI keys, CLI
 * prompt) so the offer set never drifts between them. A browser submit
 * or off-site request is granted per site (`site-grants.ts`), so `[s]`
 * is offered only when it names exactly one host.
 */
export function canGrantCategory(request: ApprovalRequest): boolean {
  if (!isGrantableCategory(request.category)) return false;
  if (isSiteScopedCategory(request.category)) return siteGrantHost(request) !== null;
  return true;
}

/**
 * What `[s]` grants, in the words a prompt shows after "allow":
 * `browser commit on example.com` for a per-site grant, the category's
 * label otherwise.
 */
export function describeCategoryGrant(request: ApprovalRequest): string {
  const label = formatApprovalCategory(request.category);
  const host = siteGrantHost(request);
  return host !== null ? `${label} on ${host}` : label;
}

function withSites(
  snapshot: { categories: ApprovalCategory[]; shapes: string[] },
  sites: ReadonlySet<string>,
): SessionGrantsSnapshot {
  if (sites.size === 0) return snapshot;
  return { ...snapshot, sites: [...sites].map(parseSiteGrantKey) };
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

/**
 * A shell command, ordinary or dangerous (`shell_dangerous`, ATO-1220):
 * the same-turn denial rule treats both alike.
 */
function isShellCommandCategory(category: ApprovalCategory): boolean {
  return category === "shell" || category === "shell_dangerous";
}

/**
 * A call's identity for the same-turn denial rule: what the prompt
 * showed the user, not its id. Whitespace in the preview is collapsed so a command
 * re-emitted with different spacing is still the same command; target
 * paths are normalised, so `./notes.txt` and `notes.txt` are one file.
 */
function callKey(request: ApprovalRequest): string {
  return JSON.stringify([
    request.tool,
    request.category,
    request.reason,
    (request.preview ?? "").replace(/\s+/g, " ").trim(),
    [...(request.affectedResources ?? [])].sort(),
    normaliseTargets(request.targetPaths).sort(),
  ]);
}

/** `targetPaths` resolved and de-duplicated (`..`, `.`, trailing `/`). */
function normaliseTargets(paths: readonly string[] | undefined): string[] {
  if (paths === undefined) return [];
  return [...new Set(paths.map((p) => resolvePath(p)))];
}
