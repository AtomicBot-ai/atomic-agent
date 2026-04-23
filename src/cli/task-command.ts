import { getConfig } from "../config/index.js";
import { TaskStore, type TaskRecord, type TaskStatus } from "../tasks/index.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";

const HELP =
  [
    "atomic-agent task — manage durable task queue",
    "",
    "Tasks are deferred runTurn submissions kept in <stateDir>/tasks.sqlite.",
    "They never run on a background ticker — drains are explicit (this CLI",
    "and the HTTP /api/tasks/drain endpoint) or implicit on create when",
    "tasks.runOnCreate is enabled (default).",
    "",
    "Subcommands:",
    "  list [--session <id>] [--status <s>] [--limit N]",
    "                            List tasks; --status accepts a CSV like 'pending,failed'",
    "  show <id>                 Print one task as JSON",
    "  create --session <id> --message <text> [--max-attempts N] [--max-steps N]",
    "                            Persist a new task (origin=cli) and auto-drain when enabled",
    "  cancel <id>               Move a task to 'cancelled' (idempotent on terminal rows)",
    "  run [<id>|--all-pending] [--session <id>]",
    "                            Manually drain — single task by id, or every pending row",
    "                            (optionally scoped to one session)",
    "",
    "Examples:",
    "  atomic-agent task list --status pending",
    "  atomic-agent task create --session s-abc --message 'tidy inbox'",
    "  atomic-agent task run --all-pending --session s-abc",
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
        return handleCreate(args.slice(1));
      case "cancel":
        return handleCancel(args.slice(1));
      case "run":
        return await handleRun(args.slice(1));
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

function handleCreate(args: string[]): number {
  const sessionId = readOption(args, "--session");
  const message = readOption(args, "--message");
  const maxAttemptsRaw = readOption(args, "--max-attempts");
  const maxStepsRaw = readOption(args, "--max-steps");
  if (!sessionId || !message) {
    process.stderr.write(
      "usage: atomic-agent task create --session <id> --message <text> [--max-attempts N] [--max-steps N]\n",
    );
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
  const store = openTaskStore();
  try {
    const created = store.create({
      sessionId,
      userMessage: message,
      origin: "cli",
      maxAttempts,
      maxSteps,
    });
    process.stdout.write(`${JSON.stringify(created, null, 2)}\n`);
    return 0;
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
 * `task run` is the only subcommand that needs a live runtime — every
 * other surface is read/write against `TaskStore`. We spin up the full
 * agent (browser + llm + tool registry) inside this handler and tear
 * it down on the way out so resources never leak when the drain
 * finishes.
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
    "session".padEnd(20) +
    " " +
    "preview";
  const rows = tasks.map((t) => {
    const att = `${t.attempts}/${t.maxAttempts}`;
    const preview = t.userMessage.replace(/\s+/g, " ").slice(0, 60);
    return (
      t.id.padEnd(38) +
      " " +
      t.status.padEnd(10) +
      " " +
      att.padEnd(5) +
      " " +
      t.sessionId.slice(0, 20).padEnd(20) +
      " " +
      preview
    );
  });
  return [header, ...rows].join("\n");
}
