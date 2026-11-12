/**
 * Per-session cooldown for the link-generator after a timeout.
 *
 * On a slow local model (a 4B on a 16 GB laptop, a 27B with a large
 * auto window) a link-gen call that hits the hard timeout spent the
 * whole timeout keeping the machine busy and wrote nothing. Firing
 * the same call again on the very next turn usually ends the same
 * way. So after a timeout the session skips the next few link-gen
 * calls instead of retrying straight away:
 *
 *   - first timeout   → skip the next `baseCalls` calls
 *   - each further consecutive timeout doubles the window, capped at
 *     `maxCalls`
 *   - any call that reaches the model and comes back (`ok` / `none`)
 *     resets the session to "no backoff"
 *
 * State is in-memory and keyed by session id, so a new session (or a
 * restart) starts clean. Skips are reported as `skipped`, which the
 * memory-health tracker treats as neutral, so a model that can never
 * finish the call still reaches the operator warning — just a few
 * turns later.
 */
export interface LinkGeneratorBackoffOptions {
  /** Calls to skip after the first timeout. 0 disables the backoff. */
  baseCalls?: number;
  /** Upper bound for the doubled window. */
  maxCalls?: number;
}

export interface LinkGeneratorBackoff {
  /**
   * Returns the number of calls still to skip (including this one) and
   * consumes one, or 0 when the call may run.
   */
  take(sessionId: string): number;
  onTimeout(sessionId: string): number;
  onHealthy(sessionId: string): void;
}

export const DEFAULT_LINK_GENERATOR_BACKOFF_CALLS = 3;
export const DEFAULT_LINK_GENERATOR_BACKOFF_MAX_CALLS = 24;

interface SessionBackoff {
  remaining: number;
  consecutiveTimeouts: number;
}

export function createLinkGeneratorBackoff(
  options: LinkGeneratorBackoffOptions = {},
): LinkGeneratorBackoff {
  const baseCalls = Math.max(
    0,
    Math.floor(options.baseCalls ?? DEFAULT_LINK_GENERATOR_BACKOFF_CALLS),
  );
  const maxCalls = Math.max(
    baseCalls,
    Math.floor(options.maxCalls ?? DEFAULT_LINK_GENERATOR_BACKOFF_MAX_CALLS),
  );
  const sessions = new Map<string, SessionBackoff>();

  return {
    take(sessionId) {
      const state = sessions.get(sessionId);
      if (!state || state.remaining <= 0) return 0;
      const before = state.remaining;
      state.remaining -= 1;
      return before;
    },
    onTimeout(sessionId) {
      if (baseCalls === 0) return 0;
      const state = sessions.get(sessionId) ?? {
        remaining: 0,
        consecutiveTimeouts: 0,
      };
      state.consecutiveTimeouts += 1;
      const exponent = Math.min(state.consecutiveTimeouts - 1, 30);
      state.remaining = Math.min(maxCalls, baseCalls * 2 ** exponent);
      sessions.set(sessionId, state);
      return state.remaining;
    },
    onHealthy(sessionId) {
      sessions.delete(sessionId);
    },
  };
}
