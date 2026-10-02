/**
 * Tells a wedged llama-server from a busy one, for a daemon whose pid is
 * alive — the case the supervisor's death check cannot see.
 *
 * Two readings, both from the server's own endpoints:
 *
 * - **Silent.** `/health` is answered by the HTTP thread without touching
 *   the inference loop, so a server deep in a decode still answers it in
 *   microseconds. When neither `/health` nor `/slots` has answered
 *   anything — any status counts — for `WEDGE_SILENCE_MS`, the HTTP
 *   layer itself has stopped dispatching (a frozen or stopped process, a
 *   dead-locked server). A busy server never reads this way.
 * - **Stalled.** `/slots` is answered by the inference loop between
 *   batches, so a processing slot's task id and counters move between
 *   any two answers — slowly on a long prompt eval, but they move. A slot
 *   that reads processing with the same task and the same counters for
 *   `WEDGE_STALL_MS` is a loop that runs and gets nowhere (every decode
 *   failing, a cancelled task never released). Builds whose `/slots`
 *   lack the counters are never judged stalled.
 *
 * Pure state; the probes are injected. The first-token watch in
 * `llama-server-client.ts` guards the *request*; this guards the
 * *server*, and a restart is what ends the request's wait early.
 */

export const WEDGE_SILENCE_MS = 90_000;
export const WEDGE_STALL_MS = 120_000;

export type ProbeAnswer =
  | { answered: false }
  | { answered: true; slots?: unknown };

export interface WedgeSample {
  at: number;
  health: ProbeAnswer;
  slots: ProbeAnswer;
}

export class WedgeWatch {
  private lastAnswerAt: number | null = null;
  private stall: { fingerprint: string; since: number } | null = null;

  /** Forget everything — a (re)started daemon starts a new record. */
  reset(): void {
    this.lastAnswerAt = null;
    this.stall = null;
  }

  /** Feed one sample; returns why the daemon is wedged, or `null`. */
  observe(sample: WedgeSample): string | null {
    const anyAnswer = sample.health.answered || sample.slots.answered;
    if (this.lastAnswerAt === null) this.lastAnswerAt = sample.at;
    if (anyAnswer) this.lastAnswerAt = sample.at;
    if (!anyAnswer && sample.at - this.lastAnswerAt >= WEDGE_SILENCE_MS) {
      return `the model server stopped answering (${Math.round((sample.at - this.lastAnswerAt) / 1000)} s without a reply to /health or /slots)`;
    }
    if (!sample.slots.answered) return null;
    const fingerprint = processingFingerprint(sample.slots.slots);
    if (fingerprint === null) {
      this.stall = null;
      return null;
    }
    if (!this.stall || this.stall.fingerprint !== fingerprint) {
      this.stall = { fingerprint, since: sample.at };
      return null;
    }
    if (sample.at - this.stall.since >= WEDGE_STALL_MS) {
      return `the model server is stuck — a slot has shown the same progress for ${Math.round((sample.at - this.stall.since) / 1000)} s`;
    }
    return null;
  }
}

/**
 * Task id and counters of every processing slot, or `null` when no slot
 * is processing or the build does not report the counters.
 */
export function processingFingerprint(slots: unknown): string | null {
  if (!Array.isArray(slots)) return null;
  const parts: string[] = [];
  for (const raw of slots) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    if (s.is_processing !== true) continue;
    const next = Array.isArray(s.next_token) ? (s.next_token[0] as Record<string, unknown> | undefined) : undefined;
    const decoded = next?.n_decoded ?? s.n_decoded;
    const processed = s.n_prompt_tokens_processed;
    if (typeof decoded !== "number" && typeof processed !== "number") return null;
    parts.push(`${String(s.id)}:${String(s.id_task)}:${String(processed)}:${String(decoded)}`);
  }
  return parts.length > 0 ? parts.join("|") : null;
}

/** Any HTTP status is an answer; only a connect/timeout failure is not. */
export async function probeEndpoint(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeAnswer> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    const slots = res.ok ? await res.json().catch(() => undefined) : undefined;
    return { answered: true, slots };
  } catch {
    return { answered: false };
  }
}
