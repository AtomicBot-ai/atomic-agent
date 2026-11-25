import { ConfigValidationError } from "./config-validation-error.js";

/**
 * The `email` block of a webhook binding whose `source` is
 * `"atomic-mail"` (ATO-601): instead of an HTTP hit, a new message in
 * the agent's own Atomic Mail inbox from an allowed sender creates the
 * task. Opt-in twice over: nothing polls unless a binding declares this
 * source, and a binding with an empty `allowedSenders` list stays off.
 *
 *  - `allowedSenders` — required. Exact addresses (`boss@example.com`)
 *    or whole domains (`@example.com`), compared case-insensitively.
 *    Empty means the trigger is switched off.
 *  - `pollIntervalMs` — how often the inbox is read; at least 30 s,
 *    60 s when left out.
 *  - `replyByEmail` — when `true`, the agent's final answer is mailed
 *    back to the sender once the task ends, with no prompt per reply:
 *    turning it on is the operator's consent. Off when left out.
 *  - `autoStartSenders` — whose mail starts its task right away
 *    (ATO-601, decided 18.11.2026). Same forms as `allowedSenders`, and
 *    a sender here is allowed even when not listed there. Left out:
 *    only the owner's verified Atomic Mail address. Every other
 *    allowed sender's task is created paused and waits for the person
 *    to start it. `[]` makes every mail task wait.
 *  - `trustFromHeader` — when `true`, mail is accepted on the From line
 *    alone. Off when left out: a message needs `dmarc=pass`, or an
 *    SPF/DKIM pass aligned with the From domain, in the receiving
 *    server's (topmost) `Authentication-Results` header, else it is
 *    dropped and logged. Mail without that header is dropped too.
 */
export interface EmailTriggerConfig {
  allowedSenders: string[];
  /** Left out: the owner's verified address only. */
  autoStartSenders?: string[];
  pollIntervalMs: number;
  replyByEmail: boolean;
  trustFromHeader: boolean;
}

export const EMAIL_TRIGGER_DEFAULT_POLL_MS = 60_000;
export const EMAIL_TRIGGER_MIN_POLL_MS = 30_000;

/** `name@host.tld` or `@host.tld`; no spaces, one `@`. */
const SENDER_PATTERN = /^[^\s@]*@[^\s@]+\.[^\s@]+$/;

export function parseEmailTriggerConfig(
  raw: unknown,
  field: string,
): EmailTriggerConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(
      field,
      'source "atomic-mail" needs an email block with allowedSenders',
    );
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.allowedSenders)) {
    throw new ConfigValidationError(
      `${field}.allowedSenders`,
      "expected an array of addresses (empty = trigger off)",
    );
  }
  const allowedSenders = parseSenderList(obj.allowedSenders, `${field}.allowedSenders`);
  let autoStartSenders: string[] | undefined;
  if (obj.autoStartSenders !== undefined && obj.autoStartSenders !== null) {
    if (!Array.isArray(obj.autoStartSenders)) {
      throw new ConfigValidationError(
        `${field}.autoStartSenders`,
        "expected an array of addresses (left out = the owner's verified address)",
      );
    }
    autoStartSenders = parseSenderList(obj.autoStartSenders, `${field}.autoStartSenders`);
  }
  const rawPoll = obj.pollIntervalMs ?? EMAIL_TRIGGER_DEFAULT_POLL_MS;
  if (
    typeof rawPoll !== "number" ||
    !Number.isInteger(rawPoll) ||
    rawPoll < EMAIL_TRIGGER_MIN_POLL_MS
  ) {
    throw new ConfigValidationError(
      `${field}.pollIntervalMs`,
      `expected an integer >= ${EMAIL_TRIGGER_MIN_POLL_MS}`,
    );
  }
  const rawReply = obj.replyByEmail ?? false;
  if (typeof rawReply !== "boolean") {
    throw new ConfigValidationError(
      `${field}.replyByEmail`,
      "expected true or false",
    );
  }
  const rawTrust = obj.trustFromHeader ?? false;
  if (typeof rawTrust !== "boolean") {
    throw new ConfigValidationError(
      `${field}.trustFromHeader`,
      "expected true or false",
    );
  }
  return {
    allowedSenders,
    ...(autoStartSenders ? { autoStartSenders } : {}),
    pollIntervalMs: rawPoll,
    replyByEmail: rawReply,
    trustFromHeader: rawTrust,
  };
}

function parseSenderList(raw: readonly unknown[], field: string): string[] {
  const out: string[] = [];
  raw.forEach((entry, i) => {
    const value = typeof entry === "string" ? entry.trim().toLowerCase() : "";
    if (!SENDER_PATTERN.test(value)) {
      throw new ConfigValidationError(
        `${field}[${i}]`,
        `expected "name@host" or "@host", got ${JSON.stringify(entry)}`,
      );
    }
    if (!out.includes(value)) out.push(value);
  });
  return out;
}
