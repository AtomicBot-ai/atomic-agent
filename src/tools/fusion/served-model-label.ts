/**
 * The worker label on a llama.cpp server that is not ours (ATO-1562).
 *
 * Such a server holds one loaded model and serves it whatever the request
 * names, so `llm.runMode.fusion.workerModel` cannot pick anything there:
 * it was only a label, and a label that named a different model than the
 * one answering. The label is now what the server says it serves
 * (`GET /props`), and a pick that disagrees with it is said once.
 */

/** The model a llama-server's `/props` names, as a short label; null when it names none. */
export function servedModelName(props: Record<string, unknown>): string | null {
  const alias = typeof props.model_alias === "string" ? props.model_alias.trim() : "";
  const path = typeof props.model_path === "string" ? props.model_path.trim() : "";
  const raw = alias.length > 0 ? alias : path;
  if (raw.length === 0) return null;
  // An alias left at its default is the model path; show the file's name.
  const base = raw.split(/[\\/]/).pop() ?? raw;
  const name = base.replace(/\.gguf$/i, "").trim();
  return name.length > 0 ? name : null;
}

export interface WorkerLabel {
  /** What worker rows, the fan-out line and the result show. */
  label: string | null;
  /** Said when the configured pick is not what the server serves. */
  mismatch?: string;
}

/**
 * The served model wins the label; a configured pick that differs is
 * reported, never silently replaced. Without a served name (no probe, or
 * the server did not answer) the pick stays the label, as before.
 */
export function reconcileWorkerLabel(
  picked: string | null,
  served: string | null,
): WorkerLabel {
  if (served === null) return { label: picked };
  if (picked === null || picked === served) return { label: served };
  return {
    label: served,
    mismatch: `Selected ${picked}, but the server serves ${served}. The model is changed on the server side.`,
  };
}

/** Remembers which notes a session was already given, so each is said once. */
export class SaidOnce {
  private readonly said = new Map<string, Set<string>>();

  /** True the first time `text` is added for `sessionId`, false after. */
  add(sessionId: string, text: string): boolean {
    const seen = this.said.get(sessionId) ?? new Set<string>();
    if (seen.has(text)) return false;
    // Bounded: a long-lived process sees many sessions; forgetting the
    // oldest only means one more repeat of a short note.
    if (!this.said.has(sessionId) && this.said.size >= 256) {
      const oldest = this.said.keys().next().value;
      if (oldest !== undefined) this.said.delete(oldest);
    }
    seen.add(text);
    this.said.set(sessionId, seen);
    return true;
  }
}
