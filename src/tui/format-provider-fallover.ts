import type { FallbackLastSwitch } from "./llm-panel/fallback/fallback-panel-state.js";

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
  if (/\b402\b|credit|quota|insufficient|billing|payment/.test(text))
    return "billing";
  if (/\b401\b|\b403\b|unauthor|forbidden|invalid api key|api key/.test(text))
    return "auth";
  return "other";
}

/**
 * The Fallback pane's one-line status for the last observed switch.
 *
 * The pane is where an operator goes to act on a fallover, so the line
 * says which kind of failure happened and the one thing to do about it,
 * not the provider's raw refusal text: that full reason is already in
 * the chat notice and the Observe feed. The classifier reads free text
 * and can misread it (a per-minute "quota" is a rate limit), so a
 * credit or key line keeps the HTTP status as evidence. Only a failure
 * that clears by itself (5xx, 408, 429, a timeout, a dropped
 * connection) promises a retry; anything else — a 404 model, a context
 * overflow — keeps its reason and promises nothing. The retry names the
 * primary, not `from`: the chain can fall over from a non-primary link,
 * and the recovery probe only ever checks the primary.
 */
export function formatFallbackStatusLine(
  lastSwitch: FallbackLastSwitch,
): string {
  const { direction, from, to, reason } = lastSwitch;
  if (direction === "back") return `status: recovered primary ${to}`;
  const head = `status: failed over ${from} -> ${to}`;
  const status = /\b[45]\d\d\b/.exec(reason)?.[0];
  const evidence = status ? ` (${status})` : "";
  switch (classifyFalloverReason(reason)) {
    case "billing":
      return `${head}${evidence} · ${from} is out of credit or quota: top it up or lower its maxOutputTokens`;
    case "auth":
      return `${head}${evidence} · ${from} refused the API key: check it in <stateDir>/.env or its apiKey in config.json`;
    default:
      return isSelfClearingFailure(reason)
        ? `${head} (${reason}) · retrying the primary automatically`
        : `${head} (${reason})`;
  }
}

/** A failure the chain's recovery probe can be expected to outlast. */
function isSelfClearingFailure(reason: string): boolean {
  return /\b5\d\d\b|\b408\b|\b429\b|timeout|timed out|econnreset|econnrefused|fetch failed|network|unavailable|overloaded|rate limit/i.test(
    reason,
  );
}
