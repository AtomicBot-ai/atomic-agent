/**
 * Whether the local worker leg can still be dispatched to after a worker
 * on it was cut off (ATO-917, issue #490).
 *
 * The field case: a long local generation was cancelled at the worker's
 * time limit, and from then on every worker in the process burned its
 * whole budget with zero tool calls while the llama-server log stayed
 * empty — the server answered nothing until the app was restarted. Each
 * of those workers waited out its own queue budget before it said so.
 *
 * So the dispatcher remembers that a worker on the local leg was cut
 * (timed out, cancelled, handed back or never served) and, before it
 * sends the next worker there, asks the server the one question a busy
 * llama-server still answers (`GET /health`, see
 * `LlamaServerClient.probeHealth`). A server that answers is dispatched
 * to as before and the mark is cleared; one that does not fails the
 * worker at once with a row that says what happened and what to do,
 * instead of a silent 15-to-45-minute burn.
 *
 * One instance per `fusion.delegate` tool, i.e. per runtime: the wedge
 * outlives the fan-out that caused it.
 */
export type LocalHealthAnswer = "answered" | "unanswered";

/** Re-asks before the leg is declared unresponsive: one slow answer is not a wedge. */
export const LOCAL_LEG_HEALTH_ATTEMPTS = 2;
export const LOCAL_LEG_HEALTH_RETRY_MS = 2_000;

export const LOCAL_LEG_UNRESPONSIVE_ERROR =
  "not dispatched: the local model server stopped answering after an earlier worker on it was cut off";
export const LOCAL_LEG_UNRESPONSIVE_HINT =
  "the local server is not answering /health since a worker on it was cancelled or timed out mid-generation; restart the local server (Manage → Local models, or restart the app) before delegating again, or do this part yourself";

/** The key a mark is filed under when the caller names no server. */
export const DEFAULT_LOCAL_LEG = "local";

/**
 * Kept per local server (ATO-1318). With `mixLocalModels` two local
 * servers can serve one fan-out; one shared mark let a wedge on one
 * fail a worker sent to the other, or a healthy answer from one clear
 * the other's mark. Each leg is filed under its provider id, and only
 * a leg with a probe of its own is ever asked.
 */
export class LocalLegHealth {
  private readonly suspects = new Map<string, string>();

  /** A worker on this local leg ended by an abort; check before the next dispatch there. */
  noteCut(reason: string, leg: string = DEFAULT_LOCAL_LEG): void {
    if (!this.suspects.has(leg)) this.suspects.set(leg, reason);
  }

  /** Whether `leg` is marked; with no leg named, whether any is. */
  isSuspect(leg?: string): boolean {
    return leg === undefined ? this.suspects.size > 0 : this.suspects.has(leg);
  }

  /** Why the leg was marked, for the row's note; with no leg named, the first mark. */
  cause(leg?: string): string | null {
    if (leg !== undefined) return this.suspects.get(leg) ?? null;
    const first = this.suspects.values().next();
    return first.done === true ? null : first.value;
  }

  /**
   * Ask the leg's server before dispatching. Resolves `true` when the
   * worker may be sent: nothing on this leg was cut, there is no probe
   * for this leg to ask with, or the server answered (which clears this
   * leg's mark only). Never throws.
   */
  async readyForDispatch(
    probe: (() => Promise<LocalHealthAnswer>) | undefined,
    sleep: (ms: number) => Promise<void> = defaultSleep,
    signal?: AbortSignal,
    leg: string = DEFAULT_LOCAL_LEG,
  ): Promise<boolean> {
    if (!this.suspects.has(leg) || probe === undefined) return true;
    for (let attempt = 0; attempt < LOCAL_LEG_HEALTH_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) return true;
      if (attempt > 0) await sleep(LOCAL_LEG_HEALTH_RETRY_MS);
      let answer: LocalHealthAnswer;
      try {
        answer = await probe();
      } catch {
        answer = "unanswered";
      }
      if (answer === "answered") {
        this.suspects.delete(leg);
        return true;
      }
    }
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
