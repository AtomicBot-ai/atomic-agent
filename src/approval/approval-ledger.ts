import { AsyncLocalStorage } from "node:async_hooks";
import type { ApprovalCategory } from "./approval-level.js";

/**
 * One approval of the tool call that raised it, as it ended.
 *
 * `approved` / `denied`: a request that was actually PUT to someone, and
 * what they answered.
 *
 * `auto-approved` (ATO-1145): a request that would have been put to the
 * person but ran without asking because of something they set up earlier
 * in the session or on disk: a session grant, an allow rule, or the smart
 * approval risk review. The turn summary lists these ("Auto-approved N
 * actions"), so the person can see what ran in their name unasked. An
 * auto-approval by the standing level is NOT recorded: at level 4 that
 * would be every shell command, noise rather than news. A refuse-policy
 * denial is not recorded either: it never reached a surface.
 */
export interface ToolApprovalRecord {
  verdict: "approved" | "denied" | "auto-approved";
  category: ApprovalCategory;
  /** When the verdict reached the gate (ms epoch). */
  at: number;
  /** Set with `auto-approved` only: what let the request through. */
  via?: ApprovalAutoVia;
  /**
   * Set with `auto-approved` only: a short human line, e.g.
   * `session grant: git`, `rule r_8f3a2c1d`, `risk review: low (lists files)`.
   */
  reason?: string;
}

/** What auto-approved a request (`ToolApprovalRecord.via`). */
export type ApprovalAutoVia = "rule" | "grant" | "risk-review";

/**
 * Why this exists: the transcript a host reloads (`GET /api/sessions/{id}`)
 * had no trace of an approval at all. A host that drew the card live could
 * never put it back where it happened, so a reopened chat and a live one
 * disagreed about what the turn contained.
 *
 * The ledger is scoped with `AsyncLocalStorage` rather than keyed by
 * session or tool name because a batch runs calls concurrently: two gated
 * calls of the same tool in one step each await their own decision, and
 * only the async context of the call knows which decision is its own.
 */
const ledgerStore = new AsyncLocalStorage<ToolApprovalRecord[]>();

/** Run one tool invocation with `ledger` collecting its approvals. */
export function runWithApprovalLedger<T>(
  ledger: ToolApprovalRecord[],
  fn: () => Promise<T>,
): Promise<T> {
  return ledgerStore.run(ledger, fn);
}

/** The ledger of the tool call running in this async context, if any. */
export function currentApprovalLedger(): ToolApprovalRecord[] | undefined {
  return ledgerStore.getStore();
}

/**
 * Record an auto-approval on the ledger of the tool call running in this
 * async context (a no-op outside one: a probe, a test, a host call). The
 * gate calls it for a session grant and a `low` risk review; the allow
 * rule path of the rules file calls it with `via: "rule"`.
 */
export function recordAutoApproval(
  via: ApprovalAutoVia,
  category: ApprovalCategory,
  reason: string,
): void {
  currentApprovalLedger()?.push({
    verdict: "auto-approved",
    category,
    at: Date.now(),
    via,
    reason,
  });
}
