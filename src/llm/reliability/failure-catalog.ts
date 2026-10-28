/**
 * One shared list of why a turn went wrong: cause → phrase → action
 * (ATO-384, umbrella ATO-353).
 *
 * Every host used to word a failure on its own. The desktop matched
 * regexes over the agent's sentence, the terminal had its own table, and
 * the same 429 read three different ways. This is the single list they
 * read instead: a stable `cause` id to branch on, a short plain `phrase`
 * to show as-is, and an `action` naming the one button that helps.
 *
 * Pure data. The classifier that picks an entry for a raw error lives in
 * `classify-failure-cause.ts`; nothing here inspects an error.
 *
 * Rules for an entry:
 *  - `cause` ids are stable wire values. Add new ones; never rename or
 *    reuse one, because a host branches on it.
 *  - `phrase` is English, one sentence, no status codes, no config keys,
 *    no provider names (the host knows which provider it picked).
 *  - `action` is one of {@link FailureAction}; `none` when no button
 *    would help.
 */

/**
 * The button a host offers for a failure.
 *
 *  - `retry`:            send the same message again.
 *  - `switch-model`:     pick another model or provider.
 *  - `fix-key`:          open the provider's settings to check or replace
 *                        the API key (ATO-349: a refused key never fixes
 *                        itself, and picking another model does not
 *                        either).
 *  - `new-chat-summary`: start a new chat carrying a summary of this one.
 *  - `reduce-load`:      free memory (smaller context, smaller model,
 *                        close other apps) before trying again.
 *  - `add-search-key`:   add a web search API key.
 *  - `none`:             nothing the person can press would help.
 */
export type FailureAction =
  | "retry"
  | "switch-model"
  | "fix-key"
  | "new-chat-summary"
  | "reduce-load"
  | "add-search-key"
  | "none";

export interface FailureCatalogEntry {
  readonly phrase: string;
  readonly action: FailureAction;
}

export const FAILURE_CATALOG = {
  // Machine and local model.
  out_of_memory: {
    phrase: "Your computer ran out of memory for this model.",
    action: "reduce-load",
  },
  slow_local_model: {
    phrase: "The local model is too slow to answer in time.",
    action: "switch-model",
  },
  local_engine_down: {
    phrase: "The local model isn't running.",
    action: "none",
  },
  // Same sentence as `LOCAL_SERVER_NOT_FOUND_MESSAGE`; the host's
  // Reconnect button keys on the frame's `code`, not on this action.
  local_server_not_found: {
    phrase: "This address isn't a model server, or the model isn't loaded there.",
    action: "none",
  },
  model_loading: {
    phrase: "The model is still loading. Try again in a moment.",
    action: "retry",
  },

  // Size of the conversation.
  context_too_long: {
    phrase: "This chat is too long for the model.",
    action: "new-chat-summary",
  },

  // Provider answered with a refusal.
  rate_limited: {
    phrase: "Too many requests right now. Try again in a moment.",
    action: "retry",
  },
  out_of_credit: {
    phrase: "Your account with this provider is out of credit.",
    action: "switch-model",
  },
  auth_rejected: {
    phrase: "The provider did not accept your API key.",
    action: "fix-key",
  },
  model_not_found: {
    phrase: "The provider doesn't have this model.",
    action: "switch-model",
  },
  request_rejected: {
    phrase: "The provider turned down this request.",
    action: "switch-model",
  },
  provider_trouble: {
    phrase: "The provider is having trouble right now.",
    action: "retry",
  },
  provider_error_mid_reply: {
    phrase: "The provider failed in the middle of its reply.",
    action: "retry",
  },
  provider_setup: {
    phrase: "The provider's app isn't installed or isn't signed in.",
    action: "none",
  },

  // No answer at all.
  connection_refused: {
    phrase: "Couldn't connect to the model server.",
    action: "retry",
  },
  connection_dropped: {
    phrase: "The connection dropped in the middle of the reply.",
    action: "retry",
  },
  offline: {
    phrase: "Can't reach the provider. Check your connection.",
    action: "retry",
  },
  provider_timeout: {
    phrase: "The provider took too long to answer.",
    action: "retry",
  },
  provider_unreachable: {
    phrase: "Couldn't get a reply from the provider.",
    action: "retry",
  },

  // The reply itself was unusable.
  empty_response: {
    phrase: "The model sent back an empty answer.",
    action: "retry",
  },
  reply_cut_off: {
    phrase: "The model's reply was cut off before it finished.",
    action: "retry",
  },
  unfinished_reply: {
    phrase: "The model stopped without finishing its reply.",
    action: "retry",
  },
  repeating_output: {
    phrase: "The model got stuck repeating the same text.",
    action: "switch-model",
  },
  unreadable_reply: {
    phrase: "The model's answer couldn't be understood.",
    action: "switch-model",
  },

  // The agent's own guards.
  loop_detected: {
    phrase: "The agent was going in circles, so it stopped.",
    action: "switch-model",
  },
  same_call_repeated: {
    phrase: "The agent kept repeating the same step, so it stopped.",
    action: "switch-model",
  },

  // Tools.
  web_search_needs_key: {
    phrase: "Web search needs an API key to keep working.",
    action: "add-search-key",
  },
  web_search_unavailable: {
    phrase: "Web search isn't available right now.",
    action: "retry",
  },
  tool_crashed: {
    phrase: "A tool failed unexpectedly.",
    action: "retry",
  },

  // Not a failure, and the catch-all.
  cancelled: {
    phrase: "You stopped this turn.",
    action: "none",
  },
  unknown: {
    phrase: "Something went wrong with this turn.",
    action: "retry",
  },
} as const satisfies Record<string, FailureCatalogEntry>;

export type FailureCauseId = keyof typeof FAILURE_CATALOG;

/** What a failure event or frame carries: the id, its phrase, its button. */
export interface FailureVerdict {
  readonly cause: FailureCauseId;
  readonly phrase: string;
  readonly action: FailureAction;
}

export function failureVerdict(cause: FailureCauseId): FailureVerdict {
  const entry: FailureCatalogEntry = FAILURE_CATALOG[cause];
  return { cause, phrase: entry.phrase, action: entry.action };
}

/**
 * The loop detector's sub-detectors, by the names the `loop_detected`
 * event carries. Repeated here as plain strings so this module does not
 * import the agent layer.
 */
export type LoopDetectorName =
  | "generic_repeat"
  | "no_progress"
  | "wandering"
  | "test_repeat"
  | "read_repeat"
  | "outcome_repeat";

/**
 * The verdict for a tripped loop breaker. `generic_repeat` is the exact
 * same call over and over; every other detector is a wider circle.
 */
export function loopDetectorVerdict(
  detector: LoopDetectorName | undefined,
): FailureVerdict {
  return failureVerdict(
    detector === "generic_repeat" ? "same_call_repeated" : "loop_detected",
  );
}
