import type { ContractCheck } from "./contract.js";
import type { WorkerTaskResult } from "./worker-result.js";
import { describeMissing, type ContractCheckRunner, type ContractCheckResult, type ContractCheckOutcome, type ContractReport } from "./contract-checks.js";
const CHECK_DETAIL_CHARS = 400;
const CONTRACT_LINE_CHARS = 1200;

function head(text: string, cap: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

/**
 * Run the contract's checks through the wired runner. Never throws and
 * never invents a pass: no runner, an aborted turn or a runner that
 * threw all come back as `checksSkipped` with the reason.
 */
export async function runContractChecks(
  checks: readonly ContractCheck[],
  runner: ContractCheckRunner | undefined,
  ctx: { workingDir: string; signal: AbortSignal },
): Promise<{ outcomes: ContractCheckOutcome[]; checksSkipped?: string }> {
  if (checks.length === 0) return { outcomes: [] };
  const plural = `${checks.length} check${checks.length === 1 ? "" : "s"}`;
  const checklistItem = (check: ContractCheck, i: number): string =>
    typeof check.item === "string" && check.item.trim().length > 0
      ? check.item.trim()
      : `check-${i + 1}`;
  const unchecked = (reason: string): ContractCheckOutcome[] =>
    checks.map((check, i) => ({
      ...(check.task === undefined ? {} : { task: check.task }),
      item: checklistItem(check, i),
      checked: false,
      ok: false,
      detail: reason,
    }));
  if (runner === undefined) {
    const reason = "not run — no check runner is wired";
    return {
      outcomes: unchecked(reason),
      checksSkipped: `${plural} ${reason}`,
    };
  }
  if (ctx.signal.aborted) {
    const reason = "not run — the turn was cancelled";
    return { outcomes: unchecked(reason), checksSkipped: `${plural} ${reason}` };
  }
  const specs = checks.map(({ task: _task, item: _item, ...spec }) => spec);
  let results: readonly ContractCheckResult[];
  try {
    results = (await runner(specs, ctx)).results;
  } catch (error) {
    const reason = `not run — the check runner failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      outcomes: unchecked(reason),
      checksSkipped: `${plural} ${reason}`,
    };
  }
  const outcomes = checks.map((check, i): ContractCheckOutcome => {
    const result = results[i];
    const task = check.task === undefined ? {} : { task: check.task };
    const item = checklistItem(check, i);
    if (result === undefined) {
      return { ...task, item, checked: false, ok: false, detail: "the runner returned no result" };
    }
    const detail = head(
      result.error ?? result.summary ?? (result.ok ? "passed" : "failed"),
      CHECK_DETAIL_CHARS,
    );
    return { ...task, item, checked: true, ok: result.ok, detail };
  });
  return { outcomes };
}

/**
 * Fold the checks into the rows. A task whose declared check failed
 * becomes `failed` with `checks: …` as its error — unless it was
 * cancelled, which says the operator ended it and outranks a check that
 * could not have passed. Call-level checks (no task) stay on the
 * contract line.
 */
export function applyCheckOutcomes(
  results: readonly WorkerTaskResult[],
  outcomes: readonly ContractCheckOutcome[],
): WorkerTaskResult[] {
  return results.map((result) => {
    const own = outcomes.filter((o) => o.task === result.id);
    if (own.length === 0) return result;
    const failed = own.filter((o) => !o.ok);
    const detail =
      failed.length > 0 ? failed.map((o) => o.detail).join("; ") : undefined;
    const checks = {
      total: own.length,
      failed: failed.length,
      ...(detail === undefined ? {} : { detail }),
    };
    if (failed.length === 0 || result.status === "cancelled") {
      return { ...result, checks };
    }
    const error = `checks: ${detail}`;
    return {
      ...result,
      status: "failed",
      checks,
      error: result.error === undefined ? error : `${error}; ${result.error}`,
    };
  });
}

/**
 * The `contract:` line of the status table — presence first, then why
 * some provides could not be judged at all, then the checks that belong
 * to no task, then why the checks did not run, then
 * the warnings the call was run with (an unprovided require, so the
 * orchestrator fixes the contract on its next call instead of wondering
 * why a worker never found it). Nothing when the contract declared
 * nothing checkable and raised no warning.
 */
export function contractChecklistPasses(report: ContractReport): boolean {
  if (report.checksSkipped !== undefined) return false;
  return report.checks.every((outcome) => outcome.checked !== false && outcome.ok);
}

export function renderContractLine(report: ContractReport): string | undefined {
  const parts: string[] = [];
  if (report.findings.length > 0) {
    const missing = report.findings.filter((f) => !f.present);
    parts.push(
      missing.length === 0
        ? `all ${report.findings.length} provide${report.findings.length === 1 ? "" : "s"} present`
        : `${missing.length} missing — ${missing.map(describeMissing).join("; ")}`,
    );
  }
  if (report.providesSkipped !== undefined) parts.push(report.providesSkipped);
  const diagnosticParts = [...parts];
  parts.length = 0;
  if (diagnosticParts.length > 0) parts.push(head(diagnosticParts.join("; "), CONTRACT_LINE_CHARS));
  if (report.checks.length > 0) {
    const verdicts = report.checks.map((outcome, i) => {
      const item = outcome.item ?? `check-${i + 1}`;
      const state = outcome.checked === false ? "UNCHECKED" : outcome.ok ? "PASS" : "FAIL";
      const owner = outcome.task === undefined ? "" : `[${outcome.task}] `;
      return state === "PASS"
        ? `${owner}${item}=PASS`
        : `${owner}${item}=${state} — ${outcome.detail}`;
    });
    parts.push(`checklist: ${verdicts.join("; ")}`);
  } else if (report.checksSkipped !== undefined) {
    parts.push(report.checksSkipped);
  }
  if ((report.warnings?.length ?? 0) > 0) parts.push(head(report.warnings!.join("; "), CONTRACT_LINE_CHARS));
  if (parts.length === 0) return undefined;
  return `contract: ${parts.join("; ")}`;
}
