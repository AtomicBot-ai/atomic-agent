/**
 * The chat-surface announcement for a fallover away from the primary
 * provider.
 *
 * A fallover changes which model is answering, what it costs, and how
 * good the answers are — and the chain is designed to make it seamless,
 * which is exactly why it needs saying. Until now the only trace of it
 * was a feed line in Observe › Feed: an operator working in the chat saw
 * their cloud model quietly replaced by a local one and no reason for it
 * anywhere they were looking. A billing or credential refusal never
 * heals on its own, so silence there costs a whole session.
 *
 * Recovery stays a feed line: going back to the provider the operator
 * chose restores what they already expect, and a chat bubble for it
 * would be noise.
 */
export function formatProviderFalloverNotice(
  from: string,
  to: string,
  reason: string,
): string {
  const cause = classifyFalloverReason(reason);
  return [
    `Switched from ${from} to ${to}: ${reason}`,
    cause === "billing"
      ? `${from} is refusing requests over credit or quota, which will not clear by itself — top it up, or lower that provider's maxOutputTokens so a request fits. Until then every answer comes from ${to}.`
      : cause === "auth"
        ? `${from} refused the credentials, which will not clear by itself — check the API key in <stateDir>/.env. Until then every answer comes from ${to}.`
        : `Answers come from ${to} until ${from} recovers.`,
  ].join("\n");
}

export type FalloverCause = "billing" | "auth" | "other";

/**
 * What kind of failure this was, from the reason text the chain carries.
 *
 * Only two kinds earn extra words: the ones an operator has to act on
 * rather than wait out. A 402 or a quota message means the account is
 * out of room; a 401/403 means the key is wrong. Everything else — a
 * timeout, a 5xx, a rate limit — is transient by nature and the chain's
 * own recovery probe is the right answer to it.
 */
export function classifyFalloverReason(reason: string): FalloverCause {
  const text = reason.toLowerCase();
  if (/\b402\b|credit|quota|insufficient|billing|payment/.test(text)) return "billing";
  if (/\b401\b|\b403\b|unauthor|forbidden|invalid api key|api key/.test(text)) return "auth";
  return "other";
}
