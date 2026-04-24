import { getConfig } from "../config/index.js";
import {
  TaskStore,
  TaskValidationError,
  type TaskRecord,
  type TaskSchedule,
  type TaskStatus,
} from "../tasks/index.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";

const HELP =
  [
    "atomic-agent task — manage durable task queue",
    "",
    "Tasks are deferred runTurn submissions kept in <stateDir>/tasks.sqlite.",
    "Eager drain on create is controlled by tasks.runOnCreate; scheduled",
    "tasks (--at, --cron, --every) are always left for the scheduler /",
    "the explicit `task tick` subcommand.",
    "",
    "Subcommands:",
    "  list [--session <id>] [--status <s>] [--limit N]",
    "                            List tasks; --status accepts a CSV like 'pending,failed'",
    "  show <id>                 Print one task as JSON",
    "  create [--session <id>] --message <text>",
    "         [--max-attempts N] [--max-steps N]",
    "         [--at <unix-ms> | --cron <expr> | --every <seconds>] [--tz <iana>]",
    "                            Persist a new task (origin=cli). Omit --session for a",
    "                            lazy one-shot (fresh ephemeral session at run time) or",
    "                            for a recurring task (persistent session allocated on",
    "                            create and reused across firings).",
    "  cancel <id>               Move a task to 'cancelled' (idempotent on terminal rows)",
    "  run [<id>|--all-pending] [--session <id>]",
    "                            Manually drain — single task by id, or every pending row",
    "                            (optionally scoped to one session)",
    "  tick [--limit N]          One-shot scheduler pump: drain every due task (based on",
    "                            scheduled_for) without starting the long-lived ticker",
    "",
    "Examples:",
    "  atomic-agent task list --status pending",
    "  atomic-agent task create --session s-abc --message 'tidy inbox'",
    "  atomic-agent task create --message 'morning digest' --cron '0 9 * * *' --tz Europe/Berlin",
    "  atomic-agent task run --all-pending --session s-abc",
    "  atomic-agent task tick",
  ].join("\n") + "\n";

export async function taskCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "-h" || sub === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    switch (sub) {
      case "list":
        return handleList(args.slice(1));
      case "show":
        return handleShow(args.slice(1));
      case "create":
        return await handleCreate(args.slice(1));
      case "cancel":
        return handleCancel(args.slice(1));
      case "run":
        return await handleRun(args.slice(1));
      case "tick":
        return await handleTick(args.slice(1));
      default:
        process.stderr.write(`unknown subcommand: ${sub}\n`);
        process.stderr.write(HELP);
        return 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`task ${sub} failed: ${message}\n`);
    return 1;
  }
}

function handleList(args: string[]): number {
  const sessionId = readOption(args, "--session");
  const statusRaw = readOption(args, "--status");
  const limitRaw = readOption(args, "--limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 100;
  if (!Number.isFinite(limit) || limit <= 0) {
    process.stderr.write("--limit must be a positive integer\n");
    return 1;
  }
  const status = parseStatuses(statusRaw);
  if (status === "invalid") {
    process.stderr.write(`unknown task status: ${statusRaw}\n`);
    return 1;
  }
  const store = openTaskStore();
  try {
    const tasks = store.list({
      ...(sessionId ? { sessionId } : {}),
      ...(status ? { status } : {}),
      limit,
    });
    process.stdout.write(`${formatTaskList(tasks)}\n`);
    return 0;
  } finally {
    store.close();
  }
}

function handleShow(args: string[]): number {
  const id = args[0];
  if (!id) {
    process.stderr.write("usage: atomic-agent task show <id>\n");
    return 1;
  }
  const store = openTaskStore();
  try {
    const record = store.get(id);
    if (!record) {
      process.stderr.write(`task not found: ${id}\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return 0;
  } finally {
    store.close();
  }
}

/**
 * Create goes through the full runtime when the caller asks for a
 * recurring schedule — otherwise `TaskRunner.create` cannot allocate a
 * persistent session for the task. One-shot creates still use the
 * bare `TaskStore` to avoid paying the llama bootstrap cost.
 */
async function handleCreate(args: string[]): Promise<number> {
  const sessionId = readOption(args, "--session");
  const message = readOption(args, "--message");
  const maxAttemptsRaw = readOption(args, "--max-attempts");
  const maxStepsRaw = readOption(args, "--max-steps");
  const atRaw = readOption(args, "--at");
  const cronRaw = readOption(args, "--cron");
  const everyRaw = readOption(args, "--every");
  const tz = readOption(args, "--tz");

  if (!message) {
    process.stderr.write(
      "usage: atomic-agent task create [--session <id>] --message <text> [--at <ms> | --cron <expr> | --every <seconds>] [--tz <iana>] [--max-attempts N] [--max-steps N]\n",
    );
    return 1;
  }

  const scheduleFlags = [atRaw, cronRaw, everyRaw].filter((v) => v !== undefined);
  if (scheduleFlags.length > 1) {
    process.stderr.write(
      "--at, --cron, and --every are mutually exclusive — pick one\n",
    );
    return 1;
  }
  if (tz !== undefined && cronRaw === undefined) {
    process.stderr.write("--tz is only valid with --cron\n");
    return 1;
  }

  const config = getConfig();
  const maxAttempts = maxAttemptsRaw
    ? Number.parseInt(maxAttemptsRaw, 10)
    : config.tasks.maxAttempts;
  if (!Number.isFinite(maxAttempts) || maxAttempts <= 0) {
    process.stderr.write("--max-attempts must be a positive integer\n");
    return 1;
  }
  const maxSteps = maxStepsRaw ? Number.parseInt(maxStepsRaw, 10) : null;
  if (maxSteps !== null && (!Number.isFinite(maxSteps) || maxSteps <= 0)) {
    process.stderr.write("--max-steps must be a positive integer\n");
    return 1;
  }

  let schedule: TaskSchedule | null = null;
  if (atRaw !== undefined) {
    const at = Number.parseInt(atRaw, 10);
    if (!Number.isFinite(at)) {
      process.stderr.write("--at must be a Unix timestamp in milliseconds\n");
      return 1;
    }
    schedule = { kind: "at", at };
  } else if (cronRaw !== undefined) {
    schedule = {
      kind: "cron",
      expression: cronRaw,
      ...(tz !== undefined ? { tz } : {}),
    };
  } else if (everyRaw !== undefined) {
    const seconds = Number.parseFloat(everyRaw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      process.stderr.write("--every must be a positive number of seconds\n");
      return 1;
    }
    schedule = { kind: "interval", everyMs: Math.round(seconds * 1_000) };
  }

  const isRecurring =
    schedule?.kind === "cron" || schedule?.kind === "interval";

  // Recurring tasks need a persistent session; only the full runtime
  // (which owns `SessionStore`) can allocate one. One-shot + ephemeral
  // paths stay on the bare TaskStore to skip the llama bootstrap.
  if (isRecurring) {
    const runtime = await createAgentRuntime({
      workingDir: process.cwd(),
      approvalRequired: false,
      traceDefault: false,
      overrides: { skipLlamaHealthCheck: true },
    });
    try {
      const created = runtime.taskRunner.create({
        ...(sessionId ? { sessionId } : {}),
        userMessage: message,
        origin: "cli",
        triggerSource: "user",
        maxAttempts,
        maxSteps,
        schedule,
      });
      process.stdout.write(`${JSON.stringify(created, null, 2)}\n`);
      return 0;
    } catch (err) {
      if (err instanceof TaskValidationError) {
        process.stderr.write(`validation: ${err.field}: ${err.message}\n`);
        return 1;
      }
      throw err;
    } finally {
      await runtime.shutdown();
    }
  }

  const store = openTaskStore();
  try {
    const created = store.create({
      ...(sessionId ? { sessionId } : {}),
      userMessage: message,
      origin: "cli",
      triggerSource: "user",
      maxAttempts,
      maxSteps,
      ...(schedule ? { schedule } : {}),
    });
    process.stdout.write(`${JSON.stringify(created, null, 2)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof TaskValidationError) {
      process.stderr.write(`validation: ${err.field}: ${err.message}\n`);
      return 1;
    }
    throw err;
  } finally {
    store.close();
  }
}

function handleCancel(args: string[]): number {
  const id = args[0];
  if (!id) {
    process.stderr.write("usage: atomic-agent task cancel <id>\n");
    return 1;
  }
  const store = openTaskStore();
  try {
    const cancelled = store.cancel(id);
    if (!cancelled) {
      process.stderr.write(`task not found: ${id}\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify(cancelled, null, 2)}\n`);
    return 0;
  } finally {
    store.close();
  }
}

/**
 * `task run` is the only subcommand that needs a live runtime for a
 * one-shot drain by id or by session — every other read/write surface
 * stays on the bare `TaskStore`. We spin up the full agent (browser +
 * llm + tool registry) inside this handler and tear it down on the way
 * out so resources never leak when the drain finishes.
 */
async function handleRun(args: string[]): Promise<number> {
  const config = getConfig();
  if (!config.tasks.enabled) {
    process.stderr.write("tasks subsystem disabled (config.tasks.enabled=false)\n");
    return 1;
  }
  const allPending = args.includes("--all-pending");
  const sessionId = readOption(args, "--session");
  const explicitId = args.find((arg) => !arg.startsWith("--"));
  if (!allPending && !explicitId) {
    process.stderr.write(
      "usage: atomic-agent task run <id> | --all-pending [--session <id>]\n",
    );
    return 1;
  }
  const runtime = await createAgentRuntime({
    workingDir: process.cwd(),
    approvalRequired: false,
    traceDefault: false,
    overrides: { skipLlamaHealthCheck: true },
  });
  try {
    if (explicitId) {
      const result = await runtime.taskRunner.runOne(explicitId);
      if (!result) {
        process.stderr.write(`task not found or already claimed: ${explicitId}\n`);
        return 1;
      }
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.status === "completed" ? 0 : 1;
    }
    const outcome = await runtime.taskRunner.drainPending(
      sessionId ? { sessionId } : {},
    );
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    return outcome.failed > 0 || outcome.blocked > 0 ? 1 : 0;
  } finally {
    await runtime.shutdown();
  }
}

/**
 * `task tick` is a one-shot ops-debugging pump: it asks the runner to
 * drain everything currently due (scheduled_for <= now OR immediate)
 * without starting the long-lived scheduler. Useful for cron-style CI
 * smoke tests and for manually kicking the queue after fixing a stuck
 * session.
 */
async function handleTick(args: string[]): Promise<number> {
  const config = getConfig();
  if (!config.tasks.enabled) {
    process.stderr.write("tasks subsystem disabled (config.tasks.enabled=false)\n");
    return 1;
  }
  const limitRaw = readOption(args, "--limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(limit) || limit <= 0) {
    process.stderr.write("--limit must be a positive integer\n");
    return 1;
  }
  const runtime = await createAgentRuntime({
    workingDir: process.cwd(),
    approvalRequired: false,
    traceDefault: false,
    overrides: { skipLlamaHealthCheck: true },
  });
  try {
    const outcome = await runtime.taskRunner.runDue(Date.now(), limit);
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    return outcome.failed > 0 || outcome.blocked > 0 ? 1 : 0;
  } finally {
    await runtime.shutdown();
  }
}

function openTaskStore(): TaskStore {
  return new TaskStore({ dbFile: getConfig().paths.tasksDbFile });
}

function readOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function parseStatuses(raw: string | undefined): TaskStatus[] | undefined | "invalid" {
  if (!raw) return undefined;
  const allowed: TaskStatus[] = [
    "pending",
    "running",
    "completed",
    "failed",
    "blocked",
    "cancelled",
  ];
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  for (const part of parts) {
    if (!allowed.includes(part as TaskStatus)) return "invalid";
  }
  return parts as TaskStatus[];
}

function formatTaskList(tasks: TaskRecord[]): string {
  if (tasks.length === 0) return "(no tasks)";
  const header =
    "id".padEnd(38) +
    " " +
    "status".padEnd(10) +
    " " +
    "att".padEnd(5) +
    " " +
    "schedule".padEnd(10) +
    " " +
    "next-run".padEnd(24) +
    " " +
    "session".padEnd(20) +
    " " +
    "preview";
  const rows = tasks.map((t) => {
    const att = `${t.attempts}/${t.maxAttempts}`;
    const schedule = formatScheduleLabel(t);
    const nextRun = t.scheduledFor
      ? new Date(t.scheduledFor).toISOString()
      : "-";
    const session = t.sessionId ?? "<unassigned>";
    const preview = t.userMessage.replace(/\s+/g, " ").slice(0, 60);
    return (
      t.id.padEnd(38) +
      " " +
      t.status.padEnd(10) +
      " " +
      att.padEnd(5) +
      " " +
      schedule.padEnd(10) +
      " " +
      nextRun.padEnd(24) +
      " " +
      session.slice(0, 20).padEnd(20) +
      " " +
      preview
    );
  });
  return [header, ...rows].join("\n");
}

function formatScheduleLabel(task: TaskRecord): string {
  if (!task.schedule) return "-";
  if (task.recurring) return `${task.schedule.kind}*`;
  return task.schedule.kind;
}
