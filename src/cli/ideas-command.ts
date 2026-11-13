import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";

import { getConfig } from "../config/index.js";
import { SessionStore, createEmptySessionState } from "../session/index.js";
import {
  IDEA_STATUSES,
  IdeaStateError,
  IdeaStore,
  TaskStore,
  TaskValidationError,
  acceptIdea,
  ideaToJson,
  refreshIdeas,
  type IdeaRecord,
  type IdeaStatus,
} from "../tasks/index.js";

const HELP =
  [
    "atomic-agent ideas — suggestions built from your own tasks and goals",
    "",
    "Ideas come from fixed rules over what the agent already keeps in",
    "<stateDir>: a task that failed or was blocked and was never run again,",
    "and a chat goal that stopped with checklist items still open. Nothing",
    "is sent anywhere to build them. Each idea shows why it is suggested and",
    "the record it came from. Accepted or dismissed, it is never suggested",
    "again.",
    "",
    "Subcommands:",
    "  list [--status new|accepted|dismissed] [--limit N]",
    "                            List ideas (default: the new ones)",
    "  refresh                   Rebuild the new ideas from tasks and goals",
    "  show <id>                 Print one idea as JSON",
    "  accept <id> [--prompt <text>]",
    "                            Turn the idea into a task (origin=cli); --prompt",
    "                            replaces the suggested text. The task runs on the",
    "                            next drain (`task run --all-pending` or the scheduler).",
    "                            A Retry keeps the original task's step, $ and time",
    "                            limits and notify, in a new chat in its folder.",
    "  dismiss <id>              Drop the idea for good",
    "",
    "Examples:",
    "  atomic-agent ideas refresh",
    "  atomic-agent ideas accept 3f2c… --prompt 'retry the build, skip the tests'",
  ].join("\n") + "\n";

export async function ideasCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "-h" || sub === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    switch (sub) {
      case "list":
        return handleList(args.slice(1));
      case "refresh":
        return handleRefresh();
      case "show":
        return handleShow(args.slice(1));
      case "accept":
        return handleAccept(args.slice(1));
      case "dismiss":
        return handleDismiss(args.slice(1));
      default:
        process.stderr.write(`unknown subcommand: ${sub}\n`);
        process.stderr.write(HELP);
        return 1;
    }
  } catch (err) {
    if (err instanceof IdeaStateError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    if (err instanceof TaskValidationError) {
      process.stderr.write(`validation: prompt: ${err.message}\n`);
      return 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ideas ${sub} failed: ${message}\n`);
    return 1;
  }
}

function handleList(args: string[]): number {
  const statusRaw = readOption(args, "--status") ?? "new";
  const statuses = statusRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (statuses.length === 0 || statuses.some((s) => !IDEA_STATUSES.includes(s as IdeaStatus))) {
    process.stderr.write(`unknown idea status: ${statusRaw}\n`);
    return 1;
  }
  const limitRaw = readOption(args, "--limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    process.stderr.write("--limit must be a positive integer\n");
    return 1;
  }
  return withIdeas((ideas) => {
    process.stdout.write(`${formatIdeas(ideas.list({ status: statuses as IdeaStatus[], limit }))}\n`);
    return 0;
  });
}

function handleRefresh(): number {
  const config = getConfig();
  const tasks = new TaskStore({ dbFile: config.paths.tasksDbFile });
  const sessions = new SessionStore({ dbFile: config.paths.sessionsDbFile });
  try {
    return withIdeas((ideas) => {
      const result = refreshIdeas({ ideas, tasks, sessions });
      const fresh = ideas.list({ status: "new" });
      process.stdout.write(
        `${result.added.length} new, ${result.retired.length} retired, ${fresh.length} waiting\n`,
      );
      process.stdout.write(`${formatIdeas(fresh)}\n`);
      return 0;
    });
  } finally {
    sessions.close();
    tasks.close();
  }
}

function handleShow(args: string[]): number {
  const id = args[0];
  if (!id) {
    process.stderr.write("usage: atomic-agent ideas show <id>\n");
    return 1;
  }
  return withIdeas((ideas) => {
    const idea = ideas.get(id);
    if (!idea) {
      process.stderr.write(`idea not found: ${id}\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify(ideaToJson(idea), null, 2)}\n`);
    return 0;
  });
}

function handleAccept(args: string[]): number {
  const id = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--prompt");
  if (!id) {
    process.stderr.write("usage: atomic-agent ideas accept <id> [--prompt <text>]\n");
    return 1;
  }
  const prompt = readOption(args, "--prompt");
  const config = getConfig();
  const tasks = new TaskStore({ dbFile: config.paths.tasksDbFile });
  const sessions = new SessionStore({ dbFile: config.paths.sessionsDbFile });
  try {
    return withIdeas((ideas) => {
      const accepted = acceptIdea(
        ideas,
        ({ sessionId, userMessage, carry }) => {
          // A Retry card reruns in a fresh chat opened in the original's folder
          // (when that folder still exists), with the original's limits and notify.
          let taskSessionId = sessionId;
          let opened: string | null = null;
          if (!taskSessionId && carry?.workingDir && isFolder(carry.workingDir)) {
            const fresh = createEmptySessionState({
              id: `s-${randomUUID()}`,
              workingDir: carry.workingDir,
              metadata: { source: "cli-task" },
            });
            sessions.save(fresh);
            taskSessionId = fresh.id;
            opened = fresh.id;
          }
          try {
            return tasks.create({
              ...(taskSessionId ? { sessionId: taskSessionId } : {}),
              userMessage,
              origin: "cli",
              triggerSource: "user",
              maxAttempts: config.tasks.maxAttempts,
              ...(carry
                ? {
                    maxSteps: carry.maxSteps,
                    maxCostUsd: carry.maxCostUsd,
                    maxDurationMs: carry.maxDurationMs,
                    notify: carry.notify,
                  }
                : {}),
            });
          } catch (err) {
            if (opened) sessions.delete(opened);
            throw err;
          }
        },
        id,
        {
          ...(prompt === undefined ? {} : { prompt }),
          carryFrom: { tasks, sessions },
        },
      );
      if (!accepted) {
        process.stderr.write(`idea not found: ${id}\n`);
        return 1;
      }
      process.stdout.write(
        `${JSON.stringify({ idea: ideaToJson(accepted.idea), task: accepted.task }, null, 2)}\n`,
      );
      return 0;
    });
  } finally {
    sessions.close();
    tasks.close();
  }
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function handleDismiss(args: string[]): number {
  const id = args[0];
  if (!id) {
    process.stderr.write("usage: atomic-agent ideas dismiss <id>\n");
    return 1;
  }
  return withIdeas((ideas) => {
    const idea = ideas.dismiss(id);
    if (!idea) {
      process.stderr.write(`idea not found: ${id}\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify(ideaToJson(idea), null, 2)}\n`);
    return 0;
  });
}

function withIdeas(fn: (ideas: IdeaStore) => number): number {
  const ideas = new IdeaStore({ dbFile: getConfig().paths.tasksDbFile });
  try {
    return fn(ideas);
  } finally {
    ideas.close();
  }
}

function readOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function formatIdeas(ideas: IdeaRecord[]): string {
  if (ideas.length === 0) return "(no ideas)";
  return ideas
    .map((i) =>
      [
        `${i.id}  [${i.status}] ${i.title}`,
        `    why: ${i.reason}`,
        `    evidence (${i.evidence.source} ${i.evidence.ref}): ${i.evidence.excerpt}`,
        ...(i.taskId ? [`    task: ${i.taskId}`] : []),
      ].join("\n"),
    )
    .join("\n");
}
