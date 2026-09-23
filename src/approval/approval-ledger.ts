import { AsyncLocalStorage } from "node:async_hooks";
import type { ApprovalCategory } from "./approval-level.js";

/**
 * One prompted approval, as it ended, for the tool call that raised it.
 *
 * Only a request that was actually PUT to someone is recorded — an
 * auto-approval (level or session grant) and a refuse-policy denial never
 * reach a surface, so there is nothing a host could have shown for them.
 */
export interface ToolApprovalRecord {
  verdict: "approved" | "denied";
  category: ApprovalCategory;
  /** When the verdict reached the gate (ms epoch). */
  at: number;
}

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
