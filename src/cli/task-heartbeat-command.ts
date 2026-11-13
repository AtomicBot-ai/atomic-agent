import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import { getConfig } from "../config/index.js";
import {
  HEARTBEAT_CHECKLIST_FILENAME,
  HEARTBEAT_DEFAULT_INTERVAL_MS,
  HEARTBEAT_MIN_INTERVAL_MS,
  HEARTBEAT_SENTINEL,
  SqliteHeartbeatStore,
  TaskStore,
  TaskValidationError,
  clampHeartbeatIntervalMs,
  heartbeatTaskMessage,
  parseActiveHours,
  type HeartbeatState,
  type QuietHours,
} from "../tasks/index.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import { parseDurationFlag } from "./task-budget-flags.js";

/**
 * `atomic-agent task heartbeat` (ATO-454): a recurring task that wakes
 * the agent, has it go through a checklist file, and writes to the user
 * only when there is news. Off until someone creates one.
 */
export const HEARTBEAT_HELP =
  [
    "atomic-agent task heartbeat — the agent checks a list and writes first",
    "",
    "Subcommands:",
    "  create [--every <dur>] [--checklist <path>] [--active-hours HH:MM-HH:MM]",
    "         [--notify telegram|os|telegram,os] [--session <id>]",
    "                            Every interval (default 30m, at least 5m) the agent goes",
    "                            through the checklist (default <stateDir>/" + HEARTBEAT_CHECKLIST_FILENAME + ")",
    "                            and replies " + HEARTBEAT_SENTINEL + " when there is nothing new; such runs",
    "                            are not delivered anywhere. News goes to the paired",
    "                            Telegram chat and/or a desktop notification. Outside",
    "                            --active-hours (local time) and while the checklist is",
    "                            empty, nothing runs. It runs as a normal task session with",
    "                            the model the scheduler uses; stop it with `task cancel <id>`.",
    "  list                      Heartbeats with their last check and outcome",
  ].join("\n") + "\n";

export interface HeartbeatCreateArgs {
  everyMs: number;
  /** The interval asked for was under the floor and was raised to it. */
  clamped: boolean;
  checklistPath: string;
  activeHours: QuietHours | null;
  telegram: boolean;
  osNotify: boolean;
  sessionId?: string;
}

/**
 * Read `task heartbeat create` flags. Pure, so the rules are tested
 * without a runtime: an error string for a value it cannot use.
 */
export function parseHeartbeatCreateArgs(
  args: readonly string[],
  defaults: { stateDir: string; cwd: string },
): HeartbeatCreateArgs | { error: string } {
  const everyRaw = readOption(args, "--every");
  let everyMs = HEARTBEAT_DEFAULT_INTERVAL_MS;
  if (everyRaw !== undefined) {
    const parsed = parseDurationFlag(everyRaw);
    if (parsed === null) {
      return { error: "--every must be a duration like 30m, 1h or 900 (seconds)" };
    }
    everyMs = parsed;
  }
  const clamp = clampHeartbeatIntervalMs(everyMs);

  const activeHours = parseActiveHours(readOption(args, "--active-hours"));
  if (activeHours === "invalid") {
    return { error: "--active-hours must look like 08:00-22:00 (local time)" };
  }

  const notifyRaw = readOption(args, "--notify");
  const targets = (notifyRaw ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (targets.some((t) => t !== "telegram" && t !== "os")) {
    return { error: "--notify takes telegram, os, or telegram,os" };
  }

  const checklistRaw = readOption(args, "--checklist");
  const checklistPath =
    checklistRaw === undefined
      ? resolve(defaults.stateDir, HEARTBEAT_CHECKLIST_FILENAME)
      : isAbsolute(checklistRaw)
        ? checklistRaw
        : resolve(defaults.cwd, checklistRaw);

  const sessionId = readOption(args, "--session");
  return {
    everyMs: clamp.everyMs,
    clamped: clamp.clamped,
    checklistPath,
    activeHours,
    telegram: targets.includes("telegram"),
    osNotify: targets.includes("os"),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

export async function taskHeartbeatCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "-h" || sub === "--help") {
    process.stdout.write(HEARTBEAT_HELP);
    return 0;
  }
  if (sub === "create") return handleCreate(args.slice(1));
  if (sub === "list") return handleList();
  process.stderr.write(`unknown heartbeat subcommand: ${sub}\n`);
  process.stderr.write(HEARTBEAT_HELP);
  return 1;
}

async function handleCreate(args: string[]): Promise<number> {
  const config = getConfig();
  const parsed = parseHeartbeatCreateArgs(args, {
    stateDir: config.paths.stateDir,
    cwd: process.cwd(),
  });
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  if (parsed.clamped) {
    process.stderr.write(
      `warning: heartbeats run at most every ${HEARTBEAT_MIN_INTERVAL_MS / 60_000} minutes; using that\n`,
    );
  }
  if (!parsed.telegram && !parsed.osNotify) {
    process.stderr.write(
      "warning: no --notify target; news is only kept in the heartbeat's session\n",
    );
  }

  // A recurring task needs a persistent session, which only the full
  // runtime can allocate (as `task create --every`).
  const runtime = await createAgentRuntime({
    workingDir: process.cwd(),
    approvalLevel: 5,
    traceDefault: false,
    overrides: { skipLlamaHealthCheck: true },
  });
  // The settings row goes in before the task, under the task's id, so a
  // run never sees the task without them; it is taken out again when the
  // task is not created.
  const taskId = `t-${randomUUID()}`;
  let created = false;
  try {
    const heartbeats = new SqliteHeartbeatStore({ dbFile: config.paths.tasksDbFile });
    try {
      heartbeats.put({
        taskId,
        checklistPath: parsed.checklistPath,
        activeHours: parsed.activeHours,
        osNotify: parsed.osNotify,
      });
    } finally {
      heartbeats.close();
    }
    const sessionId =
      parsed.sessionId ??
      runtime.createSession({
        metadata: { recurringTask: true, scheduleKind: "interval", heartbeat: true },
      }).id;
    const record = runtime.taskRunner.create({
      id: taskId,
      sessionId,
      userMessage: heartbeatTaskMessage(parsed.checklistPath),
      origin: "cli",
      triggerSource: "user",
      maxAttempts: config.tasks.maxAttempts,
      ...(parsed.telegram ? { notify: "telegram" as const } : {}),
      schedule: { kind: "interval", everyMs: parsed.everyMs },
    });
    created = true;
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof TaskValidationError) {
      process.stderr.write(`validation: ${err.field}: ${err.message}\n`);
      return 1;
    }
    throw err;
  } finally {
    if (!created) removeHeartbeat(config.paths.tasksDbFile, taskId);
    await runtime.shutdown();
  }
}

function removeHeartbeat(dbFile: string, taskId: string): void {
  const heartbeats = new SqliteHeartbeatStore({ dbFile });
  try {
    heartbeats.remove(taskId);
  } finally {
    heartbeats.close();
  }
}

function handleList(): number {
  const dbFile = getConfig().paths.tasksDbFile;
  const heartbeats = new SqliteHeartbeatStore({ dbFile });
  const tasks = new TaskStore({ dbFile });
  try {
    const rows = heartbeats.list().map((state) => {
      const task = tasks.get(state.taskId);
      return formatHeartbeatLine(state, task?.status ?? "missing", task?.scheduledFor ?? null);
    });
    process.stdout.write(`${rows.length === 0 ? "(no heartbeats)" : rows.join("\n")}\n`);
    return 0;
  } finally {
    tasks.close();
    heartbeats.close();
  }
}

/** One `task heartbeat list` line: a silent run reads "nothing new". */
export function formatHeartbeatLine(
  state: HeartbeatState,
  status: string,
  nextRunAt: number | null,
): string {
  const last =
    state.lastCheckedAt === null
      ? "not checked yet"
      : `${OUTCOME_LABELS[state.lastOutcome ?? "nothing_new"]} at ${new Date(state.lastCheckedAt).toISOString()}`;
  const hours = state.activeHours
    ? ` active ${state.activeHours.start}-${state.activeHours.end}`
    : "";
  const next = nextRunAt === null ? "" : ` next ${new Date(nextRunAt).toISOString()}`;
  return `${state.taskId} ${status}${hours}${next} :: ${last} :: ${state.checklistPath}`;
}

const OUTCOME_LABELS: Record<NonNullable<HeartbeatState["lastOutcome"]>, string> = {
  nothing_new: "nothing new",
  delivered: "news delivered",
  outside_active_hours: "skipped, outside active hours",
  no_checklist: "skipped, checklist empty or missing",
};

function readOption(args: readonly string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}
