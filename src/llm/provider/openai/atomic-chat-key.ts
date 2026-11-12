/**
 * Atomic Chat's Local API Server with its API key protection on
 * (ATO-1274). The server checks a key only when one is set in its
 * settings (empty by default), so a 401/403 from the `atomic-chat`
 * provider means exactly that: the protection is on and the agent sent
 * no key, or a different one. "Rejected the API key" sent people to a
 * key they never had to set; these words name both places.
 *
 * Atomic Chat keeps that key in its web view's local storage, not in a
 * file the agent could read reliably, so it is never read from there.
 *
 * A leaf with no imports, so the OpenAI-compatible HTTP client and the
 * reliability layer can both read it without a cycle.
 */

/** The preset id (`provider-presets.ts`), which the HTTP error carries as its label. */
export const ATOMIC_CHAT_PROVIDER_ID = "atomic-chat";

/** How the sentence goes on when the agent sent a key and Atomic Chat refused it. */
export const ATOMIC_CHAT_KEY_REFUSED_TAIL = "its API key protection is on and it refused the agent's key.";

/** How the sentence goes on when the agent had no key to send. */
export const ATOMIC_CHAT_KEY_MISSING_TAIL = "its API key protection is on and the agent has no key for it.";

/** What to do, with no commands in it, so every surface can show it. */
export const ATOMIC_CHAT_KEY_ADVICE =
  "Copy the API key from Atomic Chat's Local API Server settings into this provider's API key " +
  "in the Providers panel (or set ATOMIC_CHAT_API_KEY), or turn the key protection off in Atomic Chat.";

/** The fields of an `OpenAiHttpError` this reads. */
export interface AtomicChatKeyFacts {
  readonly status: number | null;
  readonly providerLabel: string;
  readonly keyProblem?: string;
}

/**
 * A 401/403 from the `atomic-chat` provider that the server judged: a
 * key that could not even be sent (`non_ascii`) keeps its own words.
 */
export function isAtomicChatKeyRefusal(err: AtomicChatKeyFacts): boolean {
  return (
    (err.status === 401 || err.status === 403) &&
    err.providerLabel === ATOMIC_CHAT_PROVIDER_ID &&
    err.keyProblem !== "non_ascii"
  );
}

/**
 * The sentence for such a refusal: no key sent, or a key refused. Keeps
 * the status ("answered 401") so a host still reads it as the provider
 * having replied.
 */
export function atomicChatKeyMessage(err: AtomicChatKeyFacts): string {
  const tail = err.keyProblem === "missing" ? ATOMIC_CHAT_KEY_MISSING_TAIL : ATOMIC_CHAT_KEY_REFUSED_TAIL;
  return `Atomic Chat answered ${err.status ?? 401}: ${tail}`;
}
