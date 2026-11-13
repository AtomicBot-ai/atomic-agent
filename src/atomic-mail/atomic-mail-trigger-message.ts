import { renderWebhookTemplate } from "../http/webhook-template.js";
import { frameUntrustedText } from "../tools/untrusted-tool-output.js";
import type { TriggerMail } from "./atomic-mail-trigger-batches.js";

/**
 * The pure rules of the mail trigger (ATO-601): who may start a task,
 * what the task's message looks like, and what goes back by mail.
 */

/** Source named in the framing line above the mail. */
export const MAIL_TRIGGER_SOURCE = "an e-mail that arrived in the agent's inbox";

/** Body characters put into a task (the task message is capped at 16 000). */
export const MAIL_TEXT_MAX_CHARS = 8_000;

/** Reply characters mailed back. */
export const REPLY_TEXT_MAX_CHARS = 20_000;

/**
 * `fromEmail` against the allow-list: an exact address, or a whole
 * domain written as `@host`. Both sides are lower-case already
 * (config parsing and `parseTriggerInbox` normalise them).
 */
export function isAllowedSender(
  fromEmail: string,
  allowedSenders: readonly string[],
): boolean {
  if (!fromEmail.includes("@")) return false;
  const domain = fromEmail.slice(fromEmail.lastIndexOf("@"));
  return allowedSenders.some((entry) =>
    entry.startsWith("@") ? entry === domain : entry === fromEmail,
  );
}

/** Outcome of {@link checkSenderAuth}: `ok`, or why the mail is refused. */
export interface SenderAuthVerdict {
  ok: boolean;
  reason: string;
}

interface AuthResultEntry {
  method: string;
  result: string;
  props: Map<string, string>;
}

/** Drops RFC 5322 comments `(...)`, nested ones included. */
function stripComments(text: string): string {
  let out = "";
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth += 1;
    else if (ch === ")" && depth > 0) depth -= 1;
    else if (depth === 0) out += ch;
  }
  return out;
}

/**
 * One `Authentication-Results` value (RFC 8601): the authserv-id, then
 * `method=result prop=value ...` entries split by `;`. The authserv-id
 * is skipped (see {@link checkSenderAuth}).
 */
function parseAuthResultsHeader(value: string): AuthResultEntry[] {
  const parts = stripComments(value).toLowerCase().split(";").slice(1);
  const entries: AuthResultEntry[] = [];
  for (const part of parts) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    const head = tokens.shift();
    const eq = head?.indexOf("=") ?? -1;
    if (!head || eq <= 0) continue;
    const props = new Map<string, string>();
    for (const token of tokens) {
      const i = token.indexOf("=");
      if (i > 0) props.set(token.slice(0, i), token.slice(i + 1).replace(/^"|"$/g, ""));
    }
    entries.push({ method: head.slice(0, eq), result: head.slice(eq + 1), props });
  }
  return entries;
}

function domainOf(value: string | undefined): string {
  if (!value) return "";
  const at = value.lastIndexOf("@");
  return (at >= 0 ? value.slice(at + 1) : value).trim().replace(/\.$/, "");
}

/**
 * Relaxed alignment without the public-suffix list: the authenticated
 * domain equals the From domain, is a subdomain of it, or is a parent
 * of it that still has at least two labels (`mail.corp.com` signed by
 * `corp.com`).
 */
function aligned(authDomain: string, fromDomain: string): boolean {
  if (!authDomain || !fromDomain) return false;
  if (authDomain === fromDomain) return true;
  if (authDomain.endsWith(`.${fromDomain}`)) return true;
  return fromDomain.endsWith(`.${authDomain}`) && authDomain.split(".").length >= 2;
}

/**
 * Whether the receiving server authenticated the From domain (ATO-601).
 *
 * Only the topmost `Authentication-Results` header counts: the inbox
 * server adds its own above everything the sender wrote, and anything
 * lower down is the sender's to forge. The agent has no record of the
 * server's authserv-id (the API does not return it), so it is not
 * matched by name; the first
 * header is taken as the server's (JMAP returns them in message order,
 * topmost first, and `parseTriggerInbox` keeps one per line).
 *
 * The mail passes on `dmarc=pass` (with `header.from` matching when
 * given), or on `spf=pass` / `dkim=pass` whose domain (`smtp.mailfrom`
 * / `header.d`, else `header.i`) is aligned with the From domain. A
 * `dmarc=fail` refuses whatever else passed. No header at all refuses.
 */
export function checkSenderAuth(
  authResults: string | null,
  fromEmail: string,
): SenderAuthVerdict {
  const topmost = authResults?.split("\n")[0]?.trim();
  if (!topmost) return { ok: false, reason: "no Authentication-Results header" };
  const fromDomain = domainOf(fromEmail.toLowerCase());
  if (!fromDomain) return { ok: false, reason: "no From domain" };
  const entries = parseAuthResultsHeader(topmost);
  const dmarc = entries.filter((e) => e.method === "dmarc");
  if (dmarc.some((e) => e.result !== "pass" && e.result !== "none")) {
    return { ok: false, reason: "DMARC did not pass" };
  }
  if (
    dmarc.some((e) => {
      const hf = domainOf(e.props.get("header.from"));
      return e.result === "pass" && (!hf || hf === fromDomain);
    })
  ) {
    return { ok: true, reason: "dmarc=pass" };
  }
  for (const e of entries) {
    if (e.result !== "pass") continue;
    if (e.method === "spf" && aligned(domainOf(e.props.get("smtp.mailfrom")), fromDomain)) {
      return { ok: true, reason: "spf=pass aligned with From" };
    }
    if (
      e.method === "dkim" &&
      aligned(domainOf(e.props.get("header.d") ?? e.props.get("header.i")), fromDomain)
    ) {
      return { ok: true, reason: "dkim=pass aligned with From" };
    }
  }
  return { ok: false, reason: "no DMARC pass or SPF/DKIM pass aligned with From" };
}

/**
 * `true` when the mail is refused on authentication: see
 * {@link checkSenderAuth}. Without `fromEmail` nothing can align, so
 * every header reads as failed.
 */
export function senderFailedAuth(authResults: string | null, fromEmail = ""): boolean {
  return !checkSenderAuth(authResults, fromEmail).ok;
}

function oneLine(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * The task's user message: the operator's template (which sees only the
 * allowed sender's address and the time), then the mail itself framed
 * as outside data. The subject and body are the sender's words and
 * never reach the template, so they cannot pose as the operator's.
 */
export function buildMailTaskMessage(template: string, mail: TriggerMail): string {
  const head = renderWebhookTemplate(template, {
    from: mail.fromEmail,
    receivedAt: mail.receivedAt,
  }).trim();
  const text =
    mail.text.length > MAIL_TEXT_MAX_CHARS
      ? `${mail.text.slice(0, MAIL_TEXT_MAX_CHARS)}\n[... mail cut at ${MAIL_TEXT_MAX_CHARS} characters]`
      : mail.text;
  const framed = frameUntrustedText(
    [
      `From: ${oneLine(mail.fromName ? `${mail.fromName} <${mail.fromEmail}>` : mail.fromEmail, 200)}`,
      `Subject: ${oneLine(mail.subject, 300)}`,
      `Received: ${oneLine(mail.receivedAt, 40)}`,
      "",
      text,
    ].join("\n"),
    MAIL_TRIGGER_SOURCE,
  );
  return `${head}\n\n${framed}`;
}

export type MailReplyOutcome = "completed" | "failed" | "blocked";

/** The mail sent back to the sender when `replyByEmail` is on. */
export function buildMailReply(input: {
  subject: string;
  outcome: MailReplyOutcome;
  replyText: string | null;
}): { subject: string; text: string } {
  const base = oneLine(input.subject, 200);
  const subject = /^re:/i.test(base) ? base : `Re: ${base || "your message"}`;
  if (input.outcome !== "completed") {
    return {
      subject,
      text: "Atomic Agent could not finish the task from your message. The operator can see the details in the agent.",
    };
  }
  const reply = (input.replyText ?? "").trim();
  const body =
    reply.length === 0
      ? "Atomic Agent finished the task from your message."
      : reply.length > REPLY_TEXT_MAX_CHARS
        ? `${reply.slice(0, REPLY_TEXT_MAX_CHARS)}\n\n[... cut]`
        : reply;
  return { subject, text: body };
}
