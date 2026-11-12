import type { SessionState } from "../session/index.js";

import { goalIdeaInputs } from "./idea-goal-source.js";
import { buildIdeaCandidates } from "./idea-rules.js";
import type { IdeaStore, IdeaSyncResult } from "./idea-store.js";
import type { IdeaRecord } from "./idea-types.js";
import type { TaskStore } from "./task-store.js";
import {
  TASK_USER_MESSAGE_MAX_LENGTH,
  TaskValidationError,
  type TaskRecord,
} from "./task-types.js";

/**
 * The three things a person (CLI, HTTP, a desktop card) does with
 * suggestions (ATO-458): refresh them from local records, accept one
 * (it becomes a task), dismiss one (its source is never offered again).
 */

/** Tasks and chats a refresh looks at; both newest first. */
export const IDEA_REFRESH_TASK_SCAN = 200;
export const IDEA_REFRESH_SESSION_SCAN = 50;

export interface IdeaRefreshDeps {
  ideas: Pick<IdeaStore, "sync">;
  tasks: Pick<TaskStore, "list">;
  sessions: { listRecent(limit?: number): Pick<SessionState, "id" | "metadata">[] };
  now?: number;
}

export function refreshIdeas(deps: IdeaRefreshDeps): IdeaSyncResult {
  const now = deps.now ?? Date.now();
  const candidates = buildIdeaCandidates({
    tasks: deps.tasks.list({ limit: IDEA_REFRESH_TASK_SCAN }),
    goals: goalIdeaInputs(deps.sessions.listRecent(IDEA_REFRESH_SESSION_SCAN)),
    now,
  });
  return deps.ideas.sync(candidates, now);
}

/** How the accepted idea becomes a task: the caller's own create path. */
export type IdeaTaskFactory = (input: {
  sessionId: string | null;
  userMessage: string;
}) => TaskRecord;

export interface AcceptedIdea {
  idea: IdeaRecord;
  task: TaskRecord;
}

/**
 * Accept a `new` idea, optionally with an edited prompt. The status
 * flips first (compare-and-swap), so two accepts of the same card file
 * one task; if the task is refused the idea goes back to `new`.
 * Returns `null` for an unknown id; throws `IdeaStateError` when the
 * idea was already decided and `TaskValidationError` for a bad prompt.
 */
export function acceptIdea(
  ideas: Pick<IdeaStore, "get" | "claimForAccept" | "attachTask" | "release">,
  createTask: IdeaTaskFactory,
  id: string,
  edits: { prompt?: string } = {},
  now: number = Date.now(),
): AcceptedIdea | null {
  const prompt = edits.prompt === undefined ? null : validatePrompt(edits.prompt);
  const before = ideas.get(id);
  if (before === null) return null;
  const claimed = ideas.claimForAccept(id, prompt, now);
  if (claimed === null) return null;
  let task: TaskRecord;
  try {
    task = createTask({ sessionId: claimed.sessionId, userMessage: claimed.prompt });
  } catch (err) {
    ideas.release(id, before.prompt, now);
    throw err;
  }
  const idea = ideas.attachTask(id, task.id, now) ?? { ...claimed, taskId: task.id };
  return { idea, task };
}

function validatePrompt(raw: string): string {
  const prompt = raw.trim();
  if (prompt.length === 0) {
    throw new TaskValidationError("userMessage", "prompt must not be empty");
  }
  if (prompt.length > TASK_USER_MESSAGE_MAX_LENGTH) {
    throw new TaskValidationError(
      "userMessage",
      `prompt must be at most ${TASK_USER_MESSAGE_MAX_LENGTH} characters`,
    );
  }
  return prompt;
}

/** JSON shape shared by the HTTP routes and `atomic-agent ideas`. */
export function ideaToJson(idea: IdeaRecord): Record<string, unknown> {
  return {
    id: idea.id,
    kind: idea.kind,
    status: idea.status,
    title: idea.title,
    reason: idea.reason,
    evidence: idea.evidence,
    prompt: idea.prompt,
    sessionId: idea.sessionId,
    taskId: idea.taskId,
    createdAt: idea.createdAt,
    updatedAt: idea.updatedAt,
    decidedAt: idea.decidedAt,
  };
}
