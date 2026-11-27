import {
  BOARD_LANES,
  BoardValidationError,
  groupCardsByLane,
  validateBoardComment,
  validateBoardPatch,
  type BoardCard,
  type BoardLane,
  type TaskStore,
} from "../tasks/index.js";

/**
 * `task board`, `task move`, `task comment`, `task assign` and
 * `task depends` (ATO-2498): the desktop's task board on the bare
 * `TaskStore`, like `task pause`. Kept apart from `task-command.ts`
 * so that file does not grow; it passes its own store opener in.
 */

export const TASK_BOARD_HELP = [
  "  board [--json] [--limit N]",
  "                            Print the task board: cards by lane (todo, doing,",
  "                            review, blocked, done) with assignee and what they wait on",
  "  move <id> <lane> [--note <text>]",
  "                            Move a card to a lane; the task's status is unchanged",
  "  comment <id> <text>       Add a comment to a card's thread; with no text, print it",
  "  assign <id> <profile|none>",
  "                            Run the card as an agent profile from now on",
  "  depends <id> [<id>...|none]",
  "                            Make a card wait on others: the scheduler leaves it",
  "                            until each of them is in Done",
];

type Open = () => TaskStore;

export function handleBoard(args: string[], openTaskStore: Open): number {
  const limitRaw = readOption(args, "--limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 200;
  if (!Number.isFinite(limit) || limit <= 0) {
    process.stderr.write("--limit must be a positive integer\n");
    return 1;
  }
  return withStore(openTaskStore, (store) => {
    const cards = store.boardCards({ limit });
    const deps = store.boardDependencyMap();
    const waiting = (id: string) => (deps.has(id) ? store.boardWaitingOn(id) : []);
    if (args.includes("--json")) {
      const out = cards.map((card) => ({
        id: card.task.id,
        lane: card.lane,
        status: card.task.status,
        assignee: card.assignee,
        note: card.note,
        dependsOn: deps.get(card.task.id) ?? [],
        waitingOn: waiting(card.task.id),
        request: card.task.userMessage,
      }));
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return 0;
    }
    if (store.boardUnavailable !== null) {
      process.stderr.write(`task board unavailable on this tasks.sqlite: ${store.boardUnavailable}\n`);
    }
    process.stdout.write(formatBoard(cards, waiting));
    return 0;
  });
}

export function handleMove(args: string[], openTaskStore: Open): number {
  const [id, lane] = args;
  if (!id || !lane || lane.startsWith("--")) {
    process.stderr.write(`usage: atomic-agent task move <id> <${BOARD_LANES.join("|")}> [--note <text>]\n`);
    return 1;
  }
  const note = readOption(args, "--note");
  return patchCard(openTaskStore, id, { lane, ...(note !== undefined ? { note } : {}) });
}

export function handleAssign(args: string[], openTaskStore: Open): number {
  const [id, profile] = args;
  if (!id || !profile) {
    process.stderr.write("usage: atomic-agent task assign <id> <profile|none>\n");
    return 1;
  }
  return patchCard(openTaskStore, id, { assignee: profile === "none" ? null : profile });
}

export function handleComment(args: string[], openTaskStore: Open): number {
  const [id, ...words] = args;
  if (!id) {
    process.stderr.write("usage: atomic-agent task comment <id> [<text>]\n");
    return 1;
  }
  return withStore(openTaskStore, (store) => {
    if (!store.get(id)) return fail(`task not found: ${id}`);
    if (store.boardCommentsUnavailable !== null) {
      return fail(`card comments unavailable on this tasks.sqlite: ${store.boardCommentsUnavailable}`);
    }
    if (words.length === 0) {
      for (const c of store.listBoardComments(id).reverse()) {
        process.stdout.write(`${new Date(c.createdAt).toISOString()}  ${c.author}/${c.kind}  ${c.text}\n`);
      }
      return 0;
    }
    const checked = validateBoardComment(words.join(" "));
    if ("error" in checked) return fail(checked.error);
    store.addBoardComment(id, { author: "person", kind: "comment", text: checked.text });
    process.stdout.write(`commented on ${id}\n`);
    return 0;
  });
}

export function handleDepends(args: string[], openTaskStore: Open): number {
  const [id, ...rest] = args;
  if (!id) {
    process.stderr.write("usage: atomic-agent task depends <id> [<id>...|none]\n");
    return 1;
  }
  return withStore(openTaskStore, (store) => {
    if (!store.get(id)) return fail(`task not found: ${id}`);
    if (rest.length === 0) {
      process.stdout.write(`${JSON.stringify({ dependsOn: store.boardDependencies(id), waitingOn: store.boardWaitingOn(id) })}\n`);
      return 0;
    }
    const set = store.setBoardDependencies(id, rest.length === 1 && rest[0] === "none" ? [] : rest);
    if (set === null) return fail(`task not found: ${id}`);
    if ("error" in set) return fail(set.error);
    process.stdout.write(
      set.dependsOn.length === 0 ? `${id} waits on nothing\n` : `${id} waits on ${set.dependsOn.join(", ")}\n`,
    );
    return 0;
  });
}

/** The board as text: one block per lane, one line per card. */
export function formatBoard(cards: BoardCard[], waitingOn: (id: string) => string[]): string {
  const grouped = groupCardsByLane(cards);
  const lines: string[] = [];
  for (const lane of BOARD_LANES) {
    lines.push(`${LANE_TITLES[lane]} (${grouped[lane].length})`);
    for (const card of grouped[lane]) {
      const extra: string[] = [];
      if (card.assignee) extra.push(`@${card.assignee}`);
      const waits = waitingOn(card.task.id);
      if (waits.length > 0) extra.push(`waits on ${waits.join(", ")}`);
      const request = card.task.userMessage.replace(/\s+/g, " ").trim();
      const title = request.length > 60 ? `${request.slice(0, 57)}...` : request;
      lines.push(`  ${card.task.id}  ${title}${extra.length > 0 ? `  [${extra.join("; ")}]` : ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const LANE_TITLES: Record<BoardLane, string> = {
  todo: "To do",
  doing: "Doing",
  review: "Review",
  blocked: "Blocked",
  done: "Done",
};

function patchCard(openTaskStore: Open, id: string, raw: Record<string, unknown>): number {
  return withStore(openTaskStore, (store) => {
    if (store.boardUnavailable !== null) {
      return fail(`task board unavailable on this tasks.sqlite: ${store.boardUnavailable}`);
    }
    try {
      const card = store.updateBoardCard(id, validateBoardPatch(raw));
      if (!card) return fail(`task not found: ${id}`);
      const who = card.assignee ? `, assigned to ${card.assignee}` : "";
      process.stdout.write(`${id} is in ${card.lane}${who}\n`);
      return 0;
    } catch (err) {
      if (err instanceof BoardValidationError) return fail(err.message);
      throw err;
    }
  });
}

function withStore(openTaskStore: Open, run: (store: TaskStore) => number): number {
  const store = openTaskStore();
  try {
    return run(store);
  } finally {
    store.close();
  }
}

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

function readOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return value;
}
