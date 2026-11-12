import { TaskStateError, type TaskStore } from "../tasks/index.js";

/**
 * `task pause <id>`, `task resume <id>` and `task runs <id> [--limit N]`
 * (ATO-590): the same controls the desktop's Tasks tab has over HTTP,
 * on the bare `TaskStore` like `task cancel`. Kept apart from
 * `task-command.ts` so that file does not grow; it passes its own store
 * opener in.
 */

export const TASK_PAUSE_HELP = [
  "  pause <id>                Pause a waiting task: the scheduler skips it until resumed",
  "  resume <id>               Resume a paused task; a recurring one is armed for its",
  "                            next firing from now (missed firings are skipped)",
  "  runs <id> [--limit N]     Print the task's past runs, newest first, as JSON",
];

export function handlePause(
  args: string[],
  openTaskStore: () => TaskStore,
): number {
  return transition(args, "pause", openTaskStore, (store, id) => store.pause(id));
}

export function handleResume(
  args: string[],
  openTaskStore: () => TaskStore,
): number {
  return transition(args, "resume", openTaskStore, (store, id) =>
    store.resume(id),
  );
}

export function handleRuns(
  args: string[],
  openTaskStore: () => TaskStore,
): number {
  const id = args.find((arg) => !arg.startsWith("--"));
  if (!id) {
    process.stderr.write("usage: atomic-agent task runs <id> [--limit N]\n");
    return 1;
  }
  const limitIdx = args.indexOf("--limit");
  const limitRaw = limitIdx >= 0 ? args[limitIdx + 1] : undefined;
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    process.stderr.write("--limit must be a positive integer\n");
    return 1;
  }
  const store = openTaskStore();
  try {
    if (!store.get(id)) {
      process.stderr.write(`task not found: ${id}\n`);
      return 1;
    }
    if (store.runLogUnavailable !== null) {
      process.stderr.write(
        `run history unavailable on this tasks.sqlite: ${store.runLogUnavailable}\n`,
      );
    }
    process.stdout.write(`${JSON.stringify(store.listRuns(id, limit), null, 2)}\n`);
    return 0;
  } finally {
    store.close();
  }
}

function transition(
  args: string[],
  verb: "pause" | "resume",
  openTaskStore: () => TaskStore,
  apply: (store: TaskStore, id: string) => ReturnType<TaskStore["pause"]>,
): number {
  const id = args[0];
  if (!id) {
    process.stderr.write(`usage: atomic-agent task ${verb} <id>\n`);
    return 1;
  }
  const store = openTaskStore();
  try {
    const record = apply(store, id);
    if (!record) {
      process.stderr.write(`task not found: ${id}\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof TaskStateError) {
      process.stderr.write(`cannot ${verb} a ${err.from} task: ${id}\n`);
      return 1;
    }
    throw err;
  } finally {
    store.close();
  }
}
