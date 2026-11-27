// Import-free, so the runtime's turn service can read it without the
// tasks layer (`npm run imports:check`).
export const TASKS_REQUEST_REVIEW_TOOL = "tasks.request_review";
export const TASKS_BLOCK_TOOL = "tasks.block";
export const TASKS_COMMENT_TOOL = "tasks.comment";

/** The tools that act on the card of the task a session is running (ATO-2497). */
export const BOARD_CARD_TOOLS: ReadonlySet<string> = new Set([
  TASKS_REQUEST_REVIEW_TOOL,
  TASKS_BLOCK_TOOL,
  TASKS_COMMENT_TOOL,
]);

/**
 * The turn's tool filter with the board card tools hidden unless the
 * turn runs a task (`checkpoint.taskId`, set by the task runner for
 * every run: a schedule, a retry, "Run now" on the board). The same
 * shape as `withAskUserVisibility`: a hidden tool leaves the prompt
 * catalog and the native wire, and dispatch refuses it. On a turn that
 * had no filter the runtime marks this one prompt-only, so the grammar
 * keeps its bytes (`promptOnlyToolFilter`).
 * A chat turn never sees them, so its prompt is the one it had before
 * these tools existed; a session that runs tasks pays one cold read
 * when it switches between a task turn and a chat turn, as on a role
 * change. A task turn gets the caller's filter back untouched.
 */
export function withBoardCardVisibility(
  filter: ((name: string) => boolean) | undefined,
  runsTask: boolean,
): ((name: string) => boolean) | undefined {
  if (runsTask) return filter;
  return filter
    ? (name) => !BOARD_CARD_TOOLS.has(name) && filter(name)
    : (name) => !BOARD_CARD_TOOLS.has(name);
}
