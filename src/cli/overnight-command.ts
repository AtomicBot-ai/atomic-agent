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

import { resolveBootApprovalLevel } from "../approval/approval-level.js";
import { getConfig } from "../config/index.js";
import { formatUsd } from "../llm/provider/usage-cost.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import { isSeaBuild, selfInvocation } from "../runtime/self-invocation.js";
import type { TaskRecord } from "../tasks/index.js";
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
  `  --hours <h>       Wall-clock cap, e.g. 8 or 1.5. Default: ${OVERNIGHT_DEFAULT_HOURS}.`,
  "  --dir <path>      Folder the agent works in. Default: the current folder.",
  "  --notify telegram Send the final result to the paired Telegram chat.",
  "  --detach          Keep running in the background; prints the task id and log path.",
  "  --no-approval     Allow every action. Without it, an action that needs approval",
  "                    is denied, since nobody is there to answer.",
  "",
  "Check a run with `atomic-agent task show <id>`, stop it with `atomic-agent task cancel <id>`.",
  "",
  "Examples:",
  '  atomic-agent overnight "migrate the tests to vitest" --budget 5 --dir ~/code/app',
  '  atag overnight "write the release notes from git log" --hours 2 --detach --notify telegram',
  "",
].join("\n");

const TERMINAL = new Set<TaskRecord["status"]>(["completed", "failed", "blocked", "cancelled"]);
const POLL_MS = 5_000;

export interface OvernightDeps {
  spawn?: typeof nodeSpawn;
  newTaskId?: () => string;
  cwd?: string;
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
  let resolveApproval: ((approvalId: string) => void) | null = null;

  const runtime = await createAgentRuntime({
    // Tools resolve paths against the session's working dir, and a
    // session takes the runtime's: this is what makes --dir the run's
    // folder rather than a hint in the prompt.
    workingDir: args.dir,
    approvalLevel: resolveBootApprovalLevel(args.noApproval, config.agent.approvalLevel),
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
  // No reason on a deny: it would reach the model as the user's own words.
  resolveApproval = (approvalId) => runtime.approvals.resolve({ approvalId, approved: false });
  // This process runs one task. Its scheduler would otherwise take
  // leadership whenever no desktop holds it and drain unrelated due
  // tasks from the shared queue for hours, under this run's approval
  // posture (every action granted with --no-approval). Its first tick
  // is a full tickMs away, so stopping it here claims nothing.
  await runtime.scheduler?.stop();

  let interrupted = 0;
  const onSignal = (): void => {
    interrupted += 1;
    if (interrupted > 1) process.exit(130);
    process.stderr.write("\nstopping the run (press Ctrl+C again to quit at once)\n");
    runtime.taskRunner.cancel(taskId);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const session = runtime.createSession({ metadata: { overnight: true } });
    sessionId = session.id;
    const created = runtime.taskStore.create({
      id: taskId,
      sessionId: session.id,
      userMessage: args.task,
      origin: "cli",
      triggerSource: "user",
      maxAttempts: 1,
      maxDurationMs: args.durationMs,
      ...(args.budgetUsd !== null ? { maxCostUsd: args.budgetUsd } : {}),
      ...(args.notify ? { notify: args.notify } : {}),
    });
    process.stderr.write(
      `overnight ${created.id}: working in ${args.dir}, up to ${args.durationMs / 3_600_000}h` +
        `${capUsd > 0 ? `, up to ${formatUsd(capUsd)}` : ", no money cap"}\n`,
    );
    const final = await runToEnd(runtime, created.id);
    process.stdout.write(
      formatOvernightSummary({
        task: final,
        elapsedMs: Date.now() - startedAt,
        capUsd,
        reply,
        deniedApprovals,
      }),
    );
    return overnightExitCode(final.status);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await runtime.shutdown();
  }
}

type OvernightRuntime = Awaited<ReturnType<typeof createAgentRuntime>>;

/**
 * Run the task here, or wait for whoever claimed it. Another process's
 * scheduler may pick the fresh pending row up first; `runOne` then hands
 * back the row as it is, and waiting on the row is enough. A `task cancel` from another terminal
 * only writes the row: seeing it cancelled, abort the turn here.
 */
async function runToEnd(runtime: OvernightRuntime, taskId: string): Promise<TaskRecord> {
  const watch = setInterval(() => {
    if (runtime.taskStore.get(taskId)?.status === "cancelled") {
      runtime.taskRunner.cancel(taskId);
    }
  }, POLL_MS);
  try {
    let record = await runtime.taskRunner.runOne(taskId);
    for (;;) {
      if (record && TERMINAL.has(record.status)) return record;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      record = runtime.taskStore.get(taskId);
      if (!record) throw new Error(`task ${taskId} disappeared from the queue`);
    }
  } finally {
    clearInterval(watch);
  }
}
