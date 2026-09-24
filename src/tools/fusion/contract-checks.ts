import { readFile, stat } from "node:fs/promises";

import { resolveUserPath } from "../os/expand-home.js";
import {
  describeProvide,
  provideSearchPaths,
  type ContractCheck,
  type ContractProvide,
  type DelegateContract,
} from "./contract.js";
import type { DelegateTask } from "./delegate-args.js";
import type { WorkerTaskResult } from "./worker-result.js";

/**
 * What the disk says about the contract once the workers are done.
 *
 * Every check here is language-agnostic on purpose: a file exists, a
 * literal appears in a file, an `id="…"` attribute appears in the
 * markup. That is enough to catch the failures the contract was written
 * for — a symbol nobody exported, an id spelled two ways — and it is
 * all a grep can honestly claim. Whether the symbol has the right shape
 * is what `checks` (a runtime, through `runChecks`) are for.
 */
export interface ContractFinding {
  task: string;
  kind: ContractProvide["kind"];
  name: string;
  /** The paths that were searched, as the contract named them. */
  where: string[];
  present: boolean;
  /** Why nothing could be said, when `present` is false for a reason other than absence. */
  detail?: string;
}

/**
 * One check's verdict as the wired runner reports it. The runner is
 * `verify`'s `runChecks`; this is the least it has to return.
 */
export interface ContractCheckResult {
  ok: boolean;
  summary?: string;
  error?: string;
}

/**
 * The seam to `verify.run`. Injected because the runner lives in
 * another module family; absent, the checks are reported as not run —
 * never as passed.
 */
export type ContractCheckRunner = (
  specs: readonly Record<string, unknown>[],
  ctx: { workingDir: string; signal: AbortSignal },
) => Promise<{ ok: boolean; results: readonly ContractCheckResult[] }>;

export interface ContractCheckOutcome {
  /** The task the check was attributed to; absent for a call-level check. */
  task?: string;
  ok: boolean;
  /** The runner's summary or error, head only. */
  detail: string;
}

/**
 * What `inspectContractProvides` could and could not say. The shape
 * mirrors `runContractChecks`: the verdicts it reached, plus the reason
 * for the ones it did not reach — never silence, which reads as "all
 * clear", and never a "missing" it did not earn.
 */
export interface ContractProvideReport {
  findings: ContractFinding[];
  /** Why some provides were not inspected, when some were not. */
  providesSkipped?: string;
}

export interface ContractReport {
  findings: ContractFinding[];
  /** Why some provides were not inspected — `ContractProvideReport`. */
  providesSkipped?: string;
  checks: ContractCheckOutcome[];
  /** Why the checks did not run, when they did not. */
  checksSkipped?: string;
  /**
   * What the contract declared that could not be honoured and was run
   * anyway — a `requires` no task provides (`contractWarnings`). The
   * workers were told; this is the orchestrator's copy.
   */
  warnings?: string[];
}

/** Files above this are not searched; a provide is not that big. */
const MAX_SEARCHED_FILE_BYTES = 8 * 1024 * 1024;
/** How much of a check's verdict a row carries. */
const CHECK_DETAIL_CHARS = 400;
/** Bound on the `contract:` line of the status table. */
const CONTRACT_LINE_CHARS = 1200;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `content` carries the provide. A symbol is matched as a whole
 * word so `HD.Ship` does not pass on `HD.Shipyard`; the boundaries are
 * lookarounds because `\b` misreads names that start or end in `$`. An
 * id is the attribute, in either quote. Everything else is the literal.
 */
export function contentProvides(
  content: string,
  provide: Pick<ContractProvide, "kind" | "name">,
): boolean {
  const name = escapeRegExp(provide.name);
  if (provide.kind === "symbol") {
    return new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(content);
  }
  if (provide.kind === "id") {
    return new RegExp(`\\bid\\s*=\\s*(?:"${name}"|'${name}')`).test(content);
  }
  return content.includes(provide.name);
}

/**
 * Whether the task that owns a provide got far enough for the disk to
 * mean anything. A task that was cancelled, or that is absent from the
 * results because its wave never started, produced nothing and was
 * never given the chance to — grepping for its output and calling the
 * absence "missing" accuses a worker of doing the job wrong when the
 * job never started. Every other status ran: `failed`, `no_changes`,
 * `max_steps` and `needs_orchestrator` all had their turn, and a task
 * that ran and provided nothing is exactly what this scan is for.
 *
 * With no results to consult — the function is called outside a
 * fan-out, or by a caller that has no rows — every provide is
 * assessed, as it always was.
 */
function ownerRan(
  task: string,
  results: readonly WorkerTaskResult[] | undefined,
): boolean {
  if (results === undefined) return true;
  const own = results.find((r) => r.id === task);
  return own !== undefined && own.status !== "cancelled";
}

/**
 * Check every provide against the working directory. Never throws: a
 * path that cannot be read counts as not providing, with the reason on
 * the finding. A non-file provide with nowhere to be looked for gets no
 * finding at all — it is the parser's warning (`contractWarnings`), on
 * the `contract:` line already, and a "missing" verdict over a search
 * that never happened would read as the worker's failure.
 *
 * The same reasoning covers a provide whose owner never ran: it gets no
 * finding either, and `providesSkipped` says so, the way
 * `runContractChecks` says why its checks did not run.
 */
export async function inspectContractProvides(
  contract: DelegateContract,
  tasks: readonly DelegateTask[],
  workingDir: string,
  options: {
    /** The rows the fan-out produced, to tell a real miss from a task that never ran. */
    results?: readonly WorkerTaskResult[];
    /** The turn's signal, so an aborted turn is named as the reason rather than the tasks. */
    signal?: AbortSignal;
  } = {},
): Promise<ContractProvideReport> {
  const findings: ContractFinding[] = [];
  /** Owners whose provides were passed over, in the order they were met. */
  const notRun: string[] = [];
  let skipped = 0;
  const cache = new Map<string, Promise<string | null>>();
  const read = (path: string): Promise<string | null> => {
    let pending = cache.get(path);
    if (pending === undefined) {
      pending = (async () => {
        try {
          const absolute = resolveUserPath(path, workingDir);
          const info = await stat(absolute);
          if (!info.isFile() || info.size > MAX_SEARCHED_FILE_BYTES) {
            return null;
          }
          return await readFile(absolute, "utf8");
        } catch {
          return null;
        }
      })();
      cache.set(path, pending);
    }
    return pending;
  };

  for (const provide of contract.provides ?? []) {
    const base = { task: provide.task, kind: provide.kind, name: provide.name };
    if (!ownerRan(provide.task, options.results)) {
      skipped += 1;
      if (!notRun.includes(provide.task)) notRun.push(provide.task);
      continue;
    }
    if (provide.kind === "file") {
      let present = false;
      try {
        present = (await stat(resolveUserPath(provide.name, workingDir))).isFile();
      } catch {
        present = false;
      }
      findings.push({ ...base, where: [provide.name], present });
      continue;
    }
    const task = tasks.find((t) => t.id === provide.task);
    const where = provideSearchPaths(provide, contract, task);
    if (where.length === 0) continue;
    let present = false;
    let unreadable = 0;
    for (const path of where) {
      const content = await read(path);
      if (content === null) {
        unreadable += 1;
        continue;
      }
      if (contentProvides(content, provide)) {
        present = true;
        break;
      }
    }
    findings.push({
      ...base,
      where,
      present,
      ...(!present && unreadable === where.length
        ? { detail: "file missing or unreadable" }
        : {}),
    });
  }
  if (skipped === 0) return { findings };
  // Named the way `runContractChecks` names its own skip: what was not
  // looked at, then the reason. An aborted turn is the reason for all of
  // them at once, so say that rather than listing every task the abort
  // cancelled.
  const plural = `${skipped} provide${skipped === 1 ? "" : "s"}`;
  const why =
    options.signal?.aborted === true
      ? "the turn was cancelled"
      : `task${notRun.length === 1 ? "" : "s"} ${notRun.join(", ")} did not run`;
  return { findings, providesSkipped: `${plural} not checked — ${why}` };
}

/** `[ship_js] symbol HD.Ship.reset not in js/ship.js` */
export function describeMissing(finding: ContractFinding): string {
  if (finding.kind === "file") {
    return `[${finding.task}] file ${finding.name} does not exist`;
  }
  const what = describeProvide({
    task: finding.task,
    kind: finding.kind,
    name: finding.name,
  });
  const where =
    finding.where.length > 0 ? `not in ${finding.where.join(", ")}` : "nowhere";
  const detail = finding.detail === undefined ? "" : ` (${finding.detail})`;
  return `[${finding.task}] ${what} ${where}${detail}`;
}

/**
 * Put each missing provide on its owner's row as a note. The status is
 * not changed: presence by grep is evidence for the orchestrator's
 * review, not a verdict on the task — that is what `checks` decide.
 */
export function applyContractFindings(
  results: readonly WorkerTaskResult[],
  findings: readonly ContractFinding[],
): WorkerTaskResult[] {
  return results.map((result) => {
    const missing = findings.filter((f) => !f.present && f.task === result.id);
    if (missing.length === 0) return result;
    const notes = [
      ...(result.notes ?? []),
      `contract: ${missing.map((f) => describeMissing(f).replace(/^\[[^\]]*\] /, "")).join("; ")}`,
    ];
    return { ...result, notes };
  });
}

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
  if (runner === undefined) {
    return {
      outcomes: [],
      checksSkipped: `${plural} not run — no check runner is wired`,
    };
  }
  if (ctx.signal.aborted) {
    return { outcomes: [], checksSkipped: `${plural} not run — the turn was cancelled` };
  }
  const specs = checks.map(({ task: _task, ...spec }) => spec);
  let results: readonly ContractCheckResult[];
  try {
    results = (await runner(specs, ctx)).results;
  } catch (error) {
    return {
      outcomes: [],
      checksSkipped: `${plural} not run — the check runner failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const outcomes = checks.map((check, i): ContractCheckOutcome => {
    const result = results[i];
    const task = check.task === undefined ? {} : { task: check.task };
    if (result === undefined) {
      return { ...task, ok: false, detail: "the runner returned no result" };
    }
    const detail = head(
      result.error ?? result.summary ?? (result.ok ? "passed" : "failed"),
      CHECK_DETAIL_CHARS,
    );
    return { ...task, ok: result.ok, detail };
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
  const callLevel = report.checks.filter((o) => o.task === undefined);
  if (callLevel.length > 0) {
    const failed = callLevel.filter((o) => !o.ok);
    parts.push(
      failed.length === 0
        ? `call-level checks: ${callLevel.length} of ${callLevel.length} passed`
        : `call-level checks: ${failed.length} of ${callLevel.length} failed — ${failed.map((o) => o.detail).join("; ")}`,
    );
  } else if (report.checks.length > 0) {
    const failed = report.checks.filter((o) => !o.ok).length;
    parts.push(
      failed === 0
        ? `checks: ${report.checks.length} of ${report.checks.length} passed`
        : `checks: ${failed} of ${report.checks.length} failed (see the task rows)`,
    );
  }
  if (report.checksSkipped !== undefined) parts.push(report.checksSkipped);
  parts.push(...(report.warnings ?? []));
  if (parts.length === 0) return undefined;
  return `contract: ${head(parts.join("; "), CONTRACT_LINE_CHARS)}`;
}
