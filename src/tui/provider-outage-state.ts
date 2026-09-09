import type { TuiState } from "./tui-state.js";

/**
 * The two state transitions of a provider outage that the agent loop
 * does not spell out for us.
 *
 * The loop emits `provider_waiting` once per backoff and
 * `provider_recovered` only after the replayed step has *finished* —
 * which, when the step streams for minutes, leaves a multi-minute gap
 * with no event in it at all. The composer used to sit in that gap
 * showing the wait counter frozen at whatever the last `provider_waiting`
 * carried, so a retry that was making progress looked exactly like a
 * hung one. `step_started` is the event that closes the gap: while an
 * outage is live it can only mean the parked step is being replayed.
 */

type ProviderOutage = NonNullable<TuiState["providerOutage"]>;

/** Park the turn: the backoff sleep has begun. */
export function parkProviderOutage(
  state: TuiState,
  event: {
    reason: string;
    waitedMs: number;
    maxWaitMs: number;
    attempt: number;
  },
  now: number = Date.now(),
): TuiState {
  const outage: ProviderOutage = {
    reason: event.reason,
    waitedMs: event.waitedMs,
    maxWaitMs: event.maxWaitMs,
    attempt: event.attempt,
    phase: "parked",
    sinceTs: now,
    givenUp: false,
  };
  return { ...state, providerOutage: outage };
}

/**
 * A step started while an outage is live: that is the parked step going
 * back on the wire.
 *
 * Besides flipping the phase this wipes what the dead attempt left
 * streaming for the same step. `appendReasoningDelta` merges into the
 * trailing reasoning entry whenever the step index matches, so without
 * this the retry's thinking is spliced onto the tail of the attempt
 * whose socket died and the operator reads the model's reasoning twice,
 * welded together mid-sentence. Same for the assistant text and the
 * half-parsed tool calls: the retry re-streams both from the beginning.
 *
 * A `givenUp` outage is left alone — it is a sticky post-mortem badge,
 * not a live wait, and the next turn's first step must not turn it back
 * into a countdown.
 */
export function retryProviderOutage(
  state: TuiState,
  stepIndex: number,
  now: number = Date.now(),
): TuiState {
  const outage = state.providerOutage;
  if (!outage || outage.givenUp) return state;
  const last = state.reasoning.at(-1);
  const reasoning =
    last && last.stepIndex === stepIndex
      ? state.reasoning.slice(0, -1)
      : state.reasoning;
  return {
    ...state,
    providerOutage: { ...outage, phase: "retrying", sinceTs: now },
    reasoning,
    streamingAssistantText: null,
    streamingToolCalls: [],
  };
}
