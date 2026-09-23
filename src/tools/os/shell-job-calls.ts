import {
  compressToolResult,
  type CompressedToolResult,
} from "../../compressor/result-compressor.js";
import {
  awaitJobExit,
  type CommandJobExit,
  type CommandJobOutput,
} from "../../sandbox/command-job.js";
import type {
  ShellJobRecord,
  ShellJobRegistry,
  ShellJobStopReason,
} from "./shell-jobs.js";
import {
  formatExitStatus,
  joinShellOutput,
  renderShellExit,
  renderShellResult,
  tailShellOutput,
} from "./shell-result.js";
import {
  formatShellDetachNotice,
  formatShellElapsed,
  resolveShellTimeout,
} from "./shell-timeout.js";

/**
 * The job forms of `os.shell.run` — `{wait}`, `{kill}`, `{jobs}` — and
 * the results a detached job produces. The tool (shell.ts) classifies
 * the call and hands these the registry; the `cmd` form stays there.
 */

/**
 * Output lines a still-running or killed result shows. The result
 * compressor keeps the last twelve non-blank lines, so the notice above
 * the command line survives only when the body is shorter than that.
 */
const RUNNING_TAIL_LINES = 8;
const KILLED_TAIL_LINES = 9;

export type ShellCallForm =
  | { kind: "cmd" }
  | { kind: "jobs" }
  | { kind: "wait"; id: number }
  | { kind: "kill"; id: number }
  | { kind: "invalid"; message: string };

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

function parseJobId(raw: unknown): number | null {
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : NaN;
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Which form a call is; exactly one of `cmd` / `wait` / `kill` / `jobs`. */
export function classifyShellCall(
  rawArgs: Record<string, unknown>,
): ShellCallForm {
  const present = ["cmd", "wait", "kill", "jobs"].filter((key) =>
    isPresent(rawArgs[key]),
  );
  if (present.length > 1) {
    return {
      kind: "invalid",
      message: `os.shell.run: pass one of cmd, wait, kill, jobs (got ${present.join(", ")})`,
    };
  }
  if (isPresent(rawArgs.jobs)) return { kind: "jobs" };
  for (const kind of ["wait", "kill"] as const) {
    if (!isPresent(rawArgs[kind])) continue;
    const id = parseJobId(rawArgs[kind]);
    if (id === null) {
      return {
        kind: "invalid",
        message: `os.shell.run: ${kind} must be a job id (a positive integer), e.g. {"${kind}": 3}; {"jobs": true} lists them`,
      };
    }
    return { kind, id };
  }
  return { kind: "cmd" };
}

export interface ShellJobCallContext {
  jobs: ShellJobRegistry;
  sessionId: string;
  /** The per-call wait a bare `{wait}` gets; `0` = unbounded. */
  defaultTimeoutMs: number;
  /** The turn's cancel: a wait returns promptly, the job keeps running. */
  signal: AbortSignal;
}

/** The first characters of a command line, for a list or a notice. */
export function headOfCommand(commandLine: string, max = 60): string {
  const line = commandLine.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const STOP_WORDING: Record<ShellJobStopReason, string> = {
  kill: "on request",
  turn_end: "at the turn's end",
  session_end: "at the session's end",
  evicted: "to stay within the job limit",
  ceiling: "at the job ceiling",
  shutdown: "at shutdown",
};

export interface ShellDetachRender {
  waitedMs: number;
  again: boolean;
  defaultTimeoutMs: number;
  evicted?: ShellJobRecord | null;
  maxJobs?: number;
  notices?: readonly string[];
}

/** A job given back still running: the notice, the tail, the id. */
export function renderShellDetached(
  record: ShellJobRecord,
  input: ShellDetachRender,
): CompressedToolResult {
  const output = record.job.output();
  const runningMs = Date.now() - record.job.startedAt;
  const notices = [...(input.notices ?? [])];
  if (input.evicted) {
    const which = input.evicted.keep ? "job (kept ones included)" : "un-kept job";
    notices.push(
      `job ${input.evicted.id} (${headOfCommand(input.evicted.facts.commandLine)}) was stopped to stay within ${input.maxJobs ?? "the limit of"} running jobs — the oldest ${which}`,
    );
  }
  notices.push(
    formatShellDetachNotice({
      jobId: record.id,
      waitedMs: input.waitedMs,
      again: input.again,
      defaultTimeoutMs: input.defaultTimeoutMs,
    }),
  );
  return renderShellResult({
    facts: record.facts,
    status: "ok",
    notices,
    statusLine: `still running (job ${record.id}, pid ${record.job.pid ?? "?"}, ${formatShellElapsed(runningMs)}${record.keep ? ", kept" : ""})`,
    body: tailShellOutput(joinShellOutput(output), RUNNING_TAIL_LINES),
    details: {
      detached: true,
      jobId: record.id,
      pid: record.job.pid ?? null,
      runningMs,
      keep: record.keep,
      timedOut: false,
      truncated: output.truncated,
      ...(input.evicted ? { evictedJobId: input.evicted.id } : {}),
    },
  });
}

/** A job that was stopped — by a `kill`, an eviction or the ceiling — once it is gone. */
function renderShellKilled(
  record: ShellJobRecord,
  exit: CommandJobExit,
  output: CommandJobOutput,
): CompressedToolResult {
  const reason = record.stopReason ?? "kill";
  return renderShellResult({
    facts: record.facts,
    status: "ok",
    notices: [],
    statusLine: `killed (job ${record.id}, ${STOP_WORDING[reason]}) after ${formatShellElapsed(exit.durationMs)}, exit: ${formatExitStatus(exit)}`,
    body: tailShellOutput(joinShellOutput(output), KILLED_TAIL_LINES),
    details: {
      killed: true,
      jobId: record.id,
      pid: record.job.pid ?? null,
      stopReason: reason,
      exitCode: exit.exitCode,
      signal: exit.signal,
      durationMs: exit.durationMs,
      timedOut: false,
      truncated: output.truncated,
    },
  });
}

function unknownJob(id: number): CompressedToolResult {
  return compressToolResult({
    tool: "os.shell.run",
    status: "error",
    output: `unknown job ${id} in this session — os.shell.run {"jobs": true} lists the jobs it has (a job that was not kept is dropped when its turn ends)`,
    details: { jobId: id, unknownJob: true },
  });
}

/** Report a finished job the way a fresh result would, and forget it. */
async function collect(
  jobs: ShellJobRegistry,
  record: ShellJobRecord,
): Promise<CompressedToolResult> {
  const exit = await awaitJobExit(record.job);
  jobs.drop(record);
  const output = record.job.output();
  if (record.state === "killed") return renderShellKilled(record, exit, output);
  return renderShellExit(record.facts, exit, output, { jobId: record.id });
}

/**
 * `{wait: id, timeoutMs?, keep?}`: block until the job exits or the
 * wait (the explicit `timeoutMs`, else the default) elapses. A turn
 * cancelled mid-wait gets the still-running result at once.
 */
export async function runShellWait(
  ctx: ShellJobCallContext,
  id: number,
  rawTimeoutMs: unknown,
  keep: boolean,
): Promise<CompressedToolResult> {
  const record = ctx.jobs.get(ctx.sessionId, id);
  if (!record) return unknownJob(id);
  if (keep) ctx.jobs.markKeep(record);
  const timeout = resolveShellTimeout(rawTimeoutMs, ctx.defaultTimeoutMs);
  if (record.state === "running") {
    const outcome = await record.job
      .waitFor(timeout.timeoutMs, ctx.signal)
      .catch(() => "exited" as const);
    if (outcome !== "exited") {
      return renderShellDetached(record, {
        waitedMs: timeout.timeoutMs,
        again: true,
        defaultTimeoutMs: ctx.defaultTimeoutMs,
      });
    }
  }
  return collect(ctx.jobs, record);
}

/** `{kill: id}`: stop the job's whole process group and report its tail. */
export async function runShellKill(
  ctx: ShellJobCallContext,
  id: number,
): Promise<CompressedToolResult> {
  const record = ctx.jobs.get(ctx.sessionId, id);
  if (!record) return unknownJob(id);
  ctx.jobs.stop(record, "kill");
  return collect(ctx.jobs, record);
}

function describeJobState(record: ShellJobRecord): string {
  const exit = record.job.exited();
  if (record.state === "running") {
    return `running ${formatShellElapsed(Date.now() - record.job.startedAt)}${record.keep ? ", kept" : ""} (pid ${record.job.pid ?? "?"})`;
  }
  const collectHint = `{"wait": ${record.id}} collects the output`;
  if (record.state === "killed") {
    return `stopped ${STOP_WORDING[record.stopReason ?? "kill"]} — ${collectHint}`;
  }
  return `exited ${exit ? formatExitStatus(exit) : "?"} after ${formatShellElapsed(exit?.durationMs ?? 0)} — ${collectHint}`;
}

/** `{jobs: true}`: this session's jobs — id, command head, started, state. */
export function listShellJobs(ctx: ShellJobCallContext): CompressedToolResult {
  const records = ctx.jobs.list(ctx.sessionId);
  const lines = records.map(
    (record) =>
      `job ${record.id}: ${headOfCommand(record.facts.commandLine)} — ${describeJobState(record)}`,
  );
  return compressToolResult({
    tool: "os.shell.run",
    status: "ok",
    output: lines.length > 0 ? lines.join("\n") : "no jobs in this session",
    details: {
      jobs: records.map((record) => ({
        id: record.id,
        cmd: headOfCommand(record.facts.commandLine, 200),
        startedAt: new Date(record.job.startedAt).toISOString(),
        state: record.state,
        pid: record.job.pid ?? null,
        keep: record.keep,
        runningMs: Date.now() - record.job.startedAt,
        exitCode: record.job.exited()?.exitCode ?? null,
        stopReason: record.stopReason,
      })),
    },
  });
}
