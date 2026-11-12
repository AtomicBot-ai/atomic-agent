/**
 * Proactive suggestions ("ideas", ATO-458): small cards the agent offers
 * from what it already has on disk, each with the evidence it came from
 * and a ready prompt. Built by fixed rules, not by the model, so a
 * refresh costs nothing and sends nothing anywhere. Accepting an idea
 * turns it into an ordinary task; dismissing it retires its source for
 * good, so the same thing is never suggested twice.
 *
 * Persistence: the `ideas` table in `tasks.sqlite` (see `idea-store.ts`).
 */

/** `new` until a person decides; `accepted` and `dismissed` are final. */
export type IdeaStatus = "new" | "accepted" | "dismissed";

export const IDEA_STATUSES: readonly IdeaStatus[] = ["new", "accepted", "dismissed"];

/**
 * Which rule produced the idea.
 *
 *  - `retry_task`: a task that failed or was blocked and was never run again.
 *  - `resume_goal`: a chat's goal that stopped (paused, out of rounds)
 *    with items on its checklist still open.
 */
export type IdeaKind = "retry_task" | "resume_goal";

/**
 * What the idea is based on: a pointer to the local record and a short
 * excerpt a person can read on the card. Never a URL, never a copy of a
 * whole transcript.
 */
export interface IdeaEvidence {
  source: "task" | "goal";
  /** The task id, or the session id the goal lives in. */
  ref: string;
  excerpt: string;
  /** When the evidence happened (task end, goal's last update), or `null`. */
  at: number | null;
}

/** What a rule proposes; the store adds identity and lifecycle. */
export interface IdeaCandidate {
  kind: IdeaKind;
  /**
   * Stable name of the source (`task:<id>`, `goal:<session>:<createdAt>`).
   * Unique in the store: once an idea for a source exists, whatever its
   * status, a later refresh never creates another one for it.
   */
  sourceKey: string;
  title: string;
  /** One sentence: why the agent suggests it. */
  reason: string;
  evidence: IdeaEvidence;
  /** The message the task will run with when the idea is accepted. */
  prompt: string;
  /** Session the accepted task runs in; `null` opens a fresh one. */
  sessionId: string | null;
}

export interface IdeaRecord extends IdeaCandidate {
  id: string;
  status: IdeaStatus;
  /** The task an accepted idea became; `null` otherwise. */
  taskId: string | null;
  createdAt: number;
  updatedAt: number;
  /** When it was accepted or dismissed. */
  decidedAt: number | null;
}

/** Cards of one kind a refresh offers at most (newest sources first). */
export const IDEAS_PER_KIND_MAX = 5;
export const IDEA_TITLE_MAX_LENGTH = 80;
export const IDEA_EXCERPT_MAX_LENGTH = 400;

/** Raised when a decision meets an idea that is no longer `new`. */
export class IdeaStateError extends Error {
  constructor(
    public readonly id: string,
    public readonly from: IdeaStatus,
    public readonly to: IdeaStatus,
  ) {
    super(`idea ${id} is already ${from}; cannot mark it ${to}`);
    this.name = "IdeaStateError";
  }
}
