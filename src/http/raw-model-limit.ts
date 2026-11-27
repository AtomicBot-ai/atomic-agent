/**
 * ATO-2336: how many outside requests may use the shared local model at
 * once. Default one.
 *
 * The managed llama-server has a few request slots that all draw from one
 * unified KV pool (`--parallel` with `-kvu`, see
 * `src/local-llm/server/worker-slots.ts`): slots are sized for the agent's
 * own turns and fusion workers, and a prompt that pushes the pool past its
 * ceiling fails every request running on it. An app on another device must
 * not take those slots from the person's own chat, so the raw routes hold
 * a small cap of their own and answer 429 above it instead of queueing.
 */

export const DEFAULT_RAW_MODEL_MAX_IN_FLIGHT = 1;

export interface InFlightLimit {
  /** A release function when a place is free, else `null`. Releasing twice is harmless. */
  tryAcquire(): (() => void) | null;
  /** Requests holding a place now. */
  readonly inFlight: number;
}

export function createInFlightLimit(max: number = DEFAULT_RAW_MODEL_MAX_IN_FLIGHT): InFlightLimit {
  const cap = Math.max(1, Math.floor(max));
  let inFlight = 0;
  return {
    tryAcquire() {
      if (inFlight >= cap) return null;
      inFlight += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlight -= 1;
      };
    },
    get inFlight() {
      return inFlight;
    },
  };
}
