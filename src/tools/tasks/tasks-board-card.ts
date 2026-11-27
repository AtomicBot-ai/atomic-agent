import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  validateBoardComment,
  type BoardCommentKind,
  type BoardLane,
  type TaskRecord,
  type TaskStore,
} from "../../tasks/index.js";
import type { ToolDefinition } from "../tool-registry.js";
import {
  TASKS_BLOCK_TOOL,
  TASKS_COMMENT_TOOL,
  TASKS_REQUEST_REVIEW_TOOL,
} from "./board-card-visibility.js";

/**
 * The agent's tools on its own board card (ATO-2497), after the Hermes
 * kanban tools (`kanban_request_review`, `kanban_block`,
 * `kanban_comment`) and the OpenClaw Workboard: while a task runs, the
 * agent can hand its card to a person for review, mark it blocked with
 * a reason, or leave a comment. They act only on the task this session
 * is running right now: the turn's filter shows them only on a task run
 * (`board-card-visibility.ts`), and a call from any other turn is
 * refused here as well. They never change the task's status; the lane
 * is a view (`task-board-lanes.ts`). A card blocked during a run is
 * held paused after it (`holdBlockedCard`).
 */
export interface BoardCardToolOptions {
  taskStore: TaskStore;
  /** The task this process is running in the session (`TaskRunner.runningTaskInSession`). */
  runningTaskInSession(sessionId: string): TaskRecord | null;
}

export { TASKS_BLOCK_TOOL, TASKS_COMMENT_TOOL, TASKS_REQUEST_REVIEW_TOOL };

interface CardAction {
  tool: string;
  description: string;
  /** The argument carrying the comment text. */
  textArg: "note" | "reason" | "text";
  textRequired: boolean;
  /** The lane the card moves to, or `null` to leave it. */
  lane: BoardLane | null;
  kind: BoardCommentKind;
  done: (taskId: string) => string;
}

const ACTIONS: Record<string, CardAction> = {
  [TASKS_REQUEST_REVIEW_TOOL]: {
    tool: TASKS_REQUEST_REVIEW_TOOL,
    description:
      "Move the task you are running to Review on the task board, for a person to check. Args: { note? }.",
    textArg: "note",
    textRequired: false,
    lane: "review",
    kind: "review",
    done: (id) => `card ${id} moved to review`,
  },
  [TASKS_BLOCK_TOOL]: {
    tool: TASKS_BLOCK_TOOL,
    description:
      "Mark the task you are running as blocked on the task board, with the reason. It is not run again until a person moves it on. Args: { reason }.",
    textArg: "reason",
    textRequired: true,
    lane: "blocked",
    kind: "block",
    done: (id) => `card ${id} moved to blocked; it waits for a person`,
  },
  [TASKS_COMMENT_TOOL]: {
    tool: TASKS_COMMENT_TOOL,
    description: "Add a comment to the task you are running, on its task board card. Args: { text }.",
    textArg: "text",
    textRequired: true,
    lane: null,
    kind: "comment",
    done: (id) => `comment added to card ${id}`,
  },
};

/** The three tools, in catalog order. */
export function buildBoardCardTools(options: BoardCardToolOptions): ToolDefinition[] {
  return [TASKS_REQUEST_REVIEW_TOOL, TASKS_BLOCK_TOOL, TASKS_COMMENT_TOOL].map((name) =>
    buildBoardCardTool(ACTIONS[name]!, options),
  );
}

function buildBoardCardTool(action: CardAction, options: BoardCardToolOptions): ToolDefinition {
  const fail = (output: string, details: Record<string, unknown>) =>
    compressToolResult({ tool: action.tool, status: "error", output, details });
  return {
    name: action.tool,
    description: action.description,
    // Only the running task's own card changes, nothing in the working
    // tree or outside: declared like `plan.update`, so a fusion
    // orchestrator running a task may still move its card.
    readonly: true,
    async run(rawArgs, ctx) {
      const task = options.runningTaskInSession(ctx.sessionId);
      if (!task) {
        return fail(
          "this chat is not running a task from the board; these tools only work inside a task run",
          { notRunningTask: true },
        );
      }
      const store = options.taskStore;
      if (store.boardUnavailable !== null) {
        return fail("the task board is not available on this agent", { boardUnavailable: true });
      }
      const raw = rawArgs[action.textArg];
      let text: string | null = null;
      if (raw !== undefined || action.textRequired) {
        const checked = validateBoardComment(raw);
        if ("error" in checked) {
          return fail(`validation: ${action.textArg} ${checked.error.replace(/^text /, "")}`, {
            field: action.textArg,
          });
        }
        text = checked.text;
      }
      const now = Date.now();
      if (action.lane !== null) store.updateBoardCard(task.id, { lane: action.lane }, now);
      // A review request without a note still leaves a line in the history.
      const commentText = text ?? (action.kind === "review" ? "Ready for review." : null);
      const comment =
        commentText === null
          ? null
          : store.addBoardComment(task.id, { author: "agent", kind: action.kind, text: commentText }, now);
      if (action.lane === null && comment === null) {
        return fail("comments are not available on this agent's task board", {
          commentsUnavailable: true,
        });
      }
      return compressToolResult({
        tool: action.tool,
        status: "ok",
        output: action.done(task.id),
        details: {
          taskId: task.id,
          ...(action.lane !== null ? { lane: action.lane } : {}),
          ...(comment ? { commentId: comment.id } : {}),
        },
      });
    },
  };
}
