/**
 * `atomic-agent overnight "<task>"` (ATO-1113): hand the agent one long
 * job with a money cap and a time cap, then walk away. The run is a
 * durable one-shot task (origin `cli`) carrying `maxCostUsd` /
 * `maxDurationMs` (ATO-1108), so `task show` / `task cancel` and the
 * Telegram report work on it like on any other task.
 *
 * Foreground by default: one line per step on stderr, a summary at the
 * end. `--detach` re-runs this command as a background child (cwd =
 * `--dir`, output to `<stateDir>/logs/overnight-<id>.log`) and returns
 * at once with the task id.
 *
 * Nobody is at the keyboard, so an action that needs approval is
 * denied (and counted) instead of waiting forever; `--no-approval`
 * runs at the top approval level, like `run --no-approval`.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ApprovalDecision } from "../approval/approval-gate.js";
import { resolveBootApprovalLevel } from "../approval/approval-level.js";
import { getConfig } from "../config/index.js";
import { formatUsd } from "../llm/provider/usage-cost.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import { isSeaBuild, selfInvocation } from "../runtime/self-invocation.js";
import { SHUTDOWN_TURN_GRACE_MS } from "../runtime/turns-in-flight.js";
import type { TaskCreateInput, TaskRecord, TaskRunner } from "../tasks/index.js";
import {
  OVERNIGHT_DEFAULT_HOURS,
  detachedChildArgs,
  parseOvernightArgs,
  type OvernightArgs,
} from "./overnight-args.js";
import {
  formatDetachedNotice,
  formatOvernightSummary,
  formatProgressLine,
  overnightExitCode,
  replyFromEvent,
} from "./overnight-progress.js";

const HELP = [
  "atomic-agent overnight - run one long task unattended, with a money and a time cap",
  "",
  'Usage: atomic-agent overnight "<task>" [--budget <usd>] [--hours <h>] [--dir <path>]',
  "                              [--notify telegram] [--detach] [--no-approval]",
  "",
  "  --budget <usd>    Stop once the estimated spend reaches this many dollars, with a",
  "                    closing summary. Default: agent.task.maxCostUsd (0 = no cap).",
  "                    Local models count as $0.",
  "                    Fusion cloud-worker spend does not count against this cap.",
  `  --hours <h>       Wall-clock cap, e.g. 8 or 1.5. Default: ${OVERNIGHT_DEFAULT_HOURS}.`,
  "  --dir <path>      Folder the agent works in. Default: the current folder.",
  "  --notify telegram Send the final result to the paired Telegram chat.",
  "  --detach          Keep running in the background; prints the task id and log path.",
  "  --no-approval     Allow every action. Without it, an action that needs approval",
  "                    is denied, since nobody is there to answer.",
  "",
  "Check a run with `atomic-agent task show <id>`, stop it with `atomic-agent task cancel <id>`.",
  "Exit code: 0 finished; 2 stopped at a limit (budget, time, steps, no progress)",
  "           or out of provider credit; 1 failed or cancelled.",
  "",
  "Examples:",
  '  atomic-agent overnight "migrate the tests to vitest" --budget 5 --dir ~/code/app',
  '  atag overnight "write the release notes from git log" --hours 2 --detach --notify telegram',
  "",
].join("\n");

const TERMINAL = new Set<TaskRecord["status"]>(["completed", "failed", "blocked", "cancelled"]);
const POLL_MS = 5_000;

/**
 * What each stop signal does to the run. Ctrl+C is the person at the
 * keyboard saying stop: the task is cancelled. SIGTERM and SIGHUP come
 * from the system (shutdown, logout, a closed terminal) in the middle
 * of the night: the run stops the way a runtime shutdown stops it, and
 * the task is left pending so it can resume instead of being lost.
 */
export const OVERNIGHT_STOP_SIGNALS = {
  SIGINT: "cancel",
  SIGTERM: "interrupt",
  SIGHUP: "interrupt",
} as const satisfies Record<string, "cancel" | "interrupt">;

type StopSignal = keyof typeof OVERNIGHT_STOP_SIGNALS;

const SIGNAL_EXIT_CODE: Record<StopSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

export interface StopSignalTarget {
  on(signal: StopSignal, listener: () => void): unknown;
  off(signal: StopSignal, listener: () => void): unknown;
}

export interface StopSignalHandle {
  /** Whether a system signal stopped the run (task left resumable). */
  interrupted(): boolean;
  dispose(): void;
}

/**
 * Wire SIGINT / SIGTERM / SIGHUP to the task runner per
 * `OVERNIGHT_STOP_SIGNALS`. A second signal of any kind quits at once.
 */
export function installStopSignals(
  runner: Pick<TaskRunner, "cancel" | "stop">,
  taskId: string,
  deps: {
    target?: StopSignalTarget;
    exit?: (code: number) => void;
    write?: (text: string) => void;
  } = {},
): StopSignalHandle {
  const target: StopSignalTarget = deps.target ?? process;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const write = deps.write ?? ((text: string) => void process.stderr.write(text));
  let received = 0;
  let interrupted = false;
  const listeners = new Map<StopSignal, () => void>();
  for (const signal of Object.keys(OVERNIGHT_STOP_SIGNALS) as StopSignal[]) {
    const listener = (): void => {
      received += 1;
      if (received > 1) {
        exit(SIGNAL_EXIT_CODE[signal]);
        return;
      }
      if (OVERNIGHT_STOP_SIGNALS[signal] === "cancel") {
        write("\nstopping the run (press Ctrl+C again to quit at once)\n");
        runner.cancel(taskId);
        return;
      }
      interrupted = true;
      write(`\n${signal}: pausing the run; the task stays queued to resume\n`);
      void runner.stop(SHUTDOWN_TURN_GRACE_MS);
    };
    listeners.set(signal, listener);
    target.on(signal, listener);
  }
  return {
    interrupted: () => interrupted,
    dispose: () => {
      for (const [signal, listener] of listeners) target.off(signal, listener);
    },
  };
}

/**
 * The task row an overnight run creates. `maxSteps` is the task-wide
 * ceiling (`agent.task.maxSteps`): left unset, the runner would fall
 * back to the per-leg `agent.maxSteps` and end the night at step 25.
 * The money cap the banner promises goes on the row too, a config cap
 * included: only a cap on the row is tracked across resumes.
 */
export function overnightTaskInput(
  args: OvernightArgs,
  taskId: string,
  sessionId: string,
  config: { agent: { task: { maxSteps: number; maxCostUsd: number } } },
  approvalLevel?: number,
): TaskCreateInput {
  const capUsd = args.budgetUsd ?? config.agent.task.maxCostUsd;
  return {
    id: taskId,
    sessionId,
    userMessage: args.task,
    origin: "cli",
    triggerSource: "user",
    maxAttempts: 1,
    maxSteps: config.agent.task.maxSteps,
    maxDurationMs: args.durationMs,
    ...(capUsd > 0 ? { maxCostUsd: capUsd } : {}),
    ...(args.notify ? { notify: args.notify } : {}),
    // Nobody is there to answer, so what this run denies or allows is
    // fixed when it starts: a resume elsewhere must keep it (ATO-1324).
    ...(approvalLevel !== undefined ? { approvalLevel } : {}),
  };
}

export interface OvernightDeps {
  spawn?: typeof nodeSpawn;
  newTaskId?: () => string;
  cwd?: string;
}

/**
 * The answer to a prompt nobody is there to see. `automatic`, so the
 * model is not told a person pressed Deny and to ask what they want.
 */
export function unattendedDenial(approvalId: string): ApprovalDecision {
  return {
    approvalId,
    approved: false,
    automatic: true,
    reason: "this is an unattended overnight run and nobody is there to approve it",
  };
}

export async function overnightCommand(argv: string[], deps: OvernightDeps = {}): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const parsed = parseOvernightArgs(argv, {
    cwd: deps.cwd ?? process.cwd(),
    isDirectory: (path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
  });
  if (!parsed.ok) {
    process.stderr.write(`overnight: ${parsed.error}\n\n${HELP}`);
    return 1;
  }
  const config = getConfig();
  if (!config.tasks.enabled) {
    process.stderr.write("overnight needs the task queue (config.tasks.enabled=false)\n");
    return 1;
  }
  const args = parsed.args;
  if (args.detach) {
    return startDetached(args, config.paths.stateDir, deps);
  }
  return runForeground(args, args.taskId ?? (deps.newTaskId ?? newTaskId)());
}

function newTaskId(): string {
  return `t-${randomUUID()}`;
}

function startDetached(args: OvernightArgs, stateDir: string, deps: OvernightDeps): number {
  const taskId = args.taskId ?? (deps.newTaskId ?? newTaskId)();
  const logDir = join(stateDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `overnight-${taskId}.log`);
  const self = selfInvocation({
    execPath: process.execPath,
    argv: process.argv,
    execArgv: process.execArgv,
    isSea: isSeaBuild(),
  });
  const logFd = openSync(logPath, "a");
  try {
    const child = (deps.spawn ?? nodeSpawn)(self.cmd, [...self.args, ...detachedChildArgs(args, taskId)], {
      cwd: args.dir,
      stdio: ["ignore", logFd, logFd],
      detached: true,
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
      // The state dir travels by environment (ATOMIC_AGENT_STATE_DIR):
      // the child must write the same tasks.sqlite the id points into.
      env: { ...process.env },
    });
    // A spawn that fails (ENOENT, EACCES, EMFILE) answers with no pid
    // and an 'error' event a tick later; unheard, that event would crash
    // this process after the message below.
    child.on("error", () => undefined);
    child.unref();
    if (child.pid == null) {
      process.stderr.write("overnight: could not start the background run\n");
      return 1;
    }
  } finally {
    closeSync(logFd);
  }
  process.stdout.write(formatDetachedNotice(taskId, logPath, args.dir));
  return 0;
}

async function runForeground(args: OvernightArgs, taskId: string): Promise<number> {
  const config = getConfig();
  const capUsd = args.budgetUsd ?? config.agent.task.maxCostUsd;
  const startedAt = Date.now();
  let sessionId: string | null = null;
  let reply: string | null = null;
  let deniedApprovals = 0;
  // What the task had already spent before this run (a resumed or
  // retried task): step events carry only this run's spend.
  let spentBeforeUsd = 0;
  let resolveApproval: ((approvalId: string) => void) | null = null;

  const approvalLevel = resolveBootApprovalLevel(args.noApproval, config.agent.approvalLevel);
  const runtime = await createAgentRuntime({
    // Tools resolve paths against the session's working dir, and a
    // session takes the runtime's: this is what makes --dir the run's
    // folder rather than a hint in the prompt.
    workingDir: args.dir,
    approvalLevel,
    handlers: {
      onAgentEvent: (event, eventSessionId) => {
        if (sessionId === null || eventSessionId !== sessionId) return;
        const text = replyFromEvent(event);
        if (text !== undefined) reply = text;
        if (event.type !== "step_finished") return;
        const line = formatProgressLine({
          stepIndex: event.stepIndex,
          summary: event.summary,
          elapsedMs: Date.now() - startedAt,
          spendUsd: event.spendUsd,
          spentBeforeUsd,
          capUsd,
        });
        process.stderr.write(`${line}\n`);
      },
      onApprovalRequest: (request) => {
        // Nobody answers here, so every request is denied; only this
        // run's own count toward its summary.
        if (sessionId !== null && request.sessionId === sessionId) {
          deniedApprovals += 1;
          process.stderr.write(
            `  needs approval: ${request.tool} (${request.reason}); denied, nobody is there to answer\n`,
          );
        }
        resolveApproval?.(request.approvalId);
      },
    },
  });
  resolveApproval = (approvalId) => runtime.approvals.resolve(unattendedDenial(approvalId));
  // This process runs one task. Its scheduler would otherwise take
  // leadership whenever no desktop holds it and drain unrelated due
  // tasks from the shared queue for hours, under this run's approval
  // posture (every action granted with --no-approval). Its first tick
  // is a full tickMs away, so stopping it here claims nothing.
  await runtime.scheduler?.stop();

  const signals = installStopSignals(runtime.taskRunner, taskId);
  try {
    const session = runtime.createSession({ metadata: { overnight: true } });
    sessionId = session.id;
    const created = runtime.taskStore.create(
      overnightTaskInput(args, taskId, session.id, config, approvalLevel),
    );
    spentBeforeUsd = runtime.taskStore.get(created.id)?.spentUsd ?? 0;
    process.stderr.write(
      `overnight ${created.id}: working in ${args.dir}, up to ${args.durationMs / 3_600_000}h` +
        `${capUsd > 0 ? `, up to ${formatUsd(capUsd)}` : ", no money cap"}\n`,
    );
    const final = await runToEnd(runtime, created.id, signals.interrupted);
    process.stdout.write(
      formatOvernightSummary({
        task: final,
        elapsedMs: Date.now() - startedAt,
        capUsd,
        reply,
        deniedApprovals,
      }),
    );
    return overnightExitCode(final);
  } finally {
    signals.dispose();
    await runtime.shutdown();
  }
}

type OvernightRuntime = Awaited<ReturnType<typeof createAgentRuntime>>;

/**
 * Run the task here, or wait for whoever claimed it. Another process's
 * scheduler may pick the fresh pending row up first; `runOne` then hands
 * back the row as it is, and waiting on the row is enough. A `task cancel` from another terminal
 * only writes the row: seeing it cancelled, abort the turn here.
 * Once a system signal has stopped the run, the row as it stands is the
 * answer: it is pending (to resume), or another process holds it.
 */
async function runToEnd(
  runtime: OvernightRuntime,
  taskId: string,
  interrupted: () => boolean,
): Promise<TaskRecord> {
  const watch = setInterval(() => {
    if (runtime.taskStore.get(taskId)?.status === "cancelled") {
      runtime.taskRunner.cancel(taskId);
    }
  }, POLL_MS);
  try {
    let record = await runtime.taskRunner.runOne(taskId);
    for (;;) {
      if (interrupted()) record = runtime.taskStore.get(taskId) ?? record;
      if (record && (TERMINAL.has(record.status) || interrupted())) return record;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      record = runtime.taskStore.get(taskId);
      if (!record) throw new Error(`task ${taskId} disappeared from the queue`);
    }
  } finally {
    clearInterval(watch);
  }
}
