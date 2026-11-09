import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The working directory of the session whose tool call is running, for
 * approval rules scoped to a project (`approval-rules.ts`). Every tool
 * asks the gate through `requireApproval`, and only the dispatcher knows
 * the session's folder; scoping it here, the way `approval-ledger.ts`
 * scopes the ledger, saves threading it through every call site. A tool
 * that knows it (the shell tool) still sets `ApprovalRequest.workdir`
 * itself, and that wins.
 */
const workdirStore = new AsyncLocalStorage<string>();

/** Run one tool invocation with `workdir` as the session's folder. */
export function runWithApprovalWorkdir<T>(
  workdir: string,
  fn: () => Promise<T>,
): Promise<T> {
  return workdirStore.run(workdir, fn);
}

/** The session folder of the tool call running in this async context, if any. */
export function currentApprovalWorkdir(): string | undefined {
  return workdirStore.getStore();
}
