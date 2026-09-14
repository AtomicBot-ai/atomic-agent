/**
 * `runVerify` — the programmatic face of `verify.run`, shared by the
 * tool and by the fan-out contract (`runChecks`).
 *
 * One result shape for the three kinds: `ok`, `kind`, `isolated`,
 * `durationMs`, the kind's own fields, the `checks` outcomes and a
 * `summary` with failures first. `ok` means the run itself went well
 * AND every check passed; a check that fails to parse fails the run.
 */
import { resolve, relative, isAbsolute } from "node:path";

import type { AtomicAgentConfig } from "../../config/index.js";
import type { ProbeSample } from "./page-probe-script.js";
import { runCommandKind } from "./run-command-kind.js";
import { type BrowserLauncher, defaultBrowserLauncher, runPageKind } from "./run-page-kind.js";
import { type FetchLike, type RequestOutcome, runServiceKind } from "./run-service-kind.js";
import { type CheckOutcome, type CheckSubject, evaluateChecks } from "./verify-checks.js";
import { parseVerifyRunArgs, type VerifyRunArgs, type VerifyRunKind } from "./verify-run-args.js";
import { renderVerifyRunSummary } from "./verify-run-summary.js";
import { createVerifyWorkspace, type VerifyWorkspace } from "./verify-workspace-copy.js";

export interface VerifyRunResult {
  readonly ok: boolean;
  readonly kind: VerifyRunKind;
  readonly isolated: boolean;
  readonly durationMs: number;
  /** A run that could not happen (no browser, bad cwd, spawn failure). */
  readonly error?: string;
  readonly commandLine?: string;
  readonly exitCode?: number | null;
  readonly timedOut?: boolean;
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
  readonly ready?: boolean;
  readonly readyMs?: number | null;
  readonly requests?: readonly RequestOutcome[];
  readonly errors?: readonly string[];
  readonly consoleErrors?: readonly string[];
  readonly consoleWarnings?: readonly string[];
  readonly requestFailures?: readonly string[];
  readonly missingSelectors?: readonly string[];
  readonly probes?: Readonly<Record<string, ProbeSample[]>>;
  readonly checks?: readonly CheckOutcome[];
  readonly summary: string;
}

export interface VerifyRunContext {
  readonly workingDir: string;
  readonly config: Pick<AtomicAgentConfig, "browser">;
  readonly signal?: AbortSignal;
  /** Test seams. */
  readonly launchBrowser?: BrowserLauncher;
  readonly fetchImpl?: FetchLike;
  readonly workspace?: (workingDir: string) => Promise<VerifyWorkspace>;
}

/** `cwd` relative to the copy, refused when it escapes it. */
function resolveRunCwd(root: string, cwd: string | undefined): string {
  if (cwd === undefined) return root;
  const target = resolve(root, cwd);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`verify.run: \`cwd\` must stay inside the working directory (got ${cwd})`);
  }
  return target;
}

function finish(
  base: Omit<VerifyRunResult, "ok" | "summary" | "checks" | "durationMs">,
  subject: CheckSubject,
  specs: readonly string[] | undefined,
  runOk: boolean,
  started: number,
): VerifyRunResult {
  // A run that did not happen (no browser, a server that never came up,
  // a command that could not start) evaluates nothing: `no errors` over
  // an empty error list would be the fake pass this tool exists to
  // refuse.
  const checks =
    specs === undefined || specs.length === 0
      ? undefined
      : base.error !== undefined
        ? specs.map((check) => ({ check, ok: false, detail: `not evaluated: ${base.error}` }))
        : evaluateChecks(specs, subject);
  const ok = runOk && (checks?.every((c) => c.ok) ?? true);
  const withoutSummary = { ...base, ok, durationMs: Date.now() - started, ...(checks === undefined ? {} : { checks }) };
  return { ...withoutSummary, summary: renderVerifyRunSummary({ ...withoutSummary, summary: "" }) };
}

async function runInWorkspace(args: VerifyRunArgs, dir: string, isolated: boolean, ctx: VerifyRunContext, started: number): Promise<VerifyRunResult> {
  const cwd = resolveRunCwd(dir, args.cwd);
  const common = { kind: args.kind, isolated };
  if (args.kind === "command") {
    const out = await runCommandKind(args, { cwd, signal: ctx.signal });
    const runOk = out.spawnError === undefined && !out.timedOut && out.exitCode === 0;
    return finish(
      { ...common, commandLine: out.commandLine, exitCode: out.exitCode, timedOut: out.timedOut, stdoutTail: out.stdoutTail, stderrTail: out.stderrTail, ...(out.spawnError === undefined ? {} : { error: `could not start \`${out.commandLine}\`: ${out.spawnError}` }) },
      { kind: "command", exitCode: out.exitCode, timedOut: out.timedOut, stdout: out.stdout, stderr: out.stderr },
      args.checks, runOk, started,
    );
  }
  if (args.kind === "service") {
    const out = await runServiceKind(args, { cwd, signal: ctx.signal, fetchImpl: ctx.fetchImpl });
    const runOk = out.ready && out.requests.every((q) => q.ok);
    return finish(
      { ...common, commandLine: out.commandLine, exitCode: out.exitCode, timedOut: out.timedOut, ready: out.ready, readyMs: out.readyMs, requests: out.requests, stdoutTail: out.stdoutTail, stderrTail: out.stderrTail, ...(out.readyError === undefined ? {} : { error: out.readyError }) },
      { kind: "service", exitCode: out.exitCode, timedOut: out.timedOut, stdout: out.stdout, stderr: out.stderr, requests: out.requests },
      args.checks, runOk, started,
    );
  }
  const out = await runPageKind(args, { cwd, signal: ctx.signal, launch: ctx.launchBrowser ?? defaultBrowserLauncher(ctx.config) });
  const runOk = out.launched && out.loaded && out.errors.length === 0 && out.consoleErrors.length === 0;
  return finish(
    { ...common, errors: out.errors, consoleErrors: out.consoleErrors, consoleWarnings: out.consoleWarnings, requestFailures: out.requestFailures, missingSelectors: out.missingSelectors, probes: out.probes, ...(out.error === undefined ? {} : { error: out.error }) },
    { kind: "page", errors: out.errors, consoleErrors: out.consoleErrors, missingSelectors: out.missingSelectors, probes: out.probes },
    args.checks, runOk, started,
  );
}

/** Run one spec against a throwaway copy of `ctx.workingDir`. */
export async function runVerify(
  rawArgs: VerifyRunArgs | Record<string, unknown>,
  ctx: VerifyRunContext,
): Promise<VerifyRunResult> {
  const started = Date.now();
  const args = parseVerifyRunArgs(rawArgs as Record<string, unknown>);
  const workspace = await (ctx.workspace ?? createVerifyWorkspace)(ctx.workingDir);
  try {
    return await runInWorkspace(args, workspace.dir, workspace.isolated, ctx, started);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const base = { kind: args.kind, isolated: workspace.isolated, error };
    return finish(base, { kind: args.kind }, args.checks, false, started);
  } finally {
    await workspace.cleanup();
  }
}

/** The fan-out contract's checks: every spec in order, `ok` when all are. */
export async function runChecks(
  specs: readonly (VerifyRunArgs | Record<string, unknown>)[],
  ctx: VerifyRunContext,
): Promise<{ ok: boolean; results: VerifyRunResult[] }> {
  const results: VerifyRunResult[] = [];
  for (const spec of specs) {
    if (ctx.signal?.aborted) break;
    try {
      results.push(await runVerify(spec, ctx));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const kind = (typeof spec.kind === "string" ? spec.kind : "command") as VerifyRunKind;
      results.push({ ok: false, kind, isolated: true, durationMs: 0, error, summary: `verify.run ${kind}: FAILED\n${error}` });
    }
  }
  return { ok: results.length === specs.length && results.every((r) => r.ok), results };
}
