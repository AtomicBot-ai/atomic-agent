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

/**
 * `true` when the receiving server says the sender is forged: DMARC
 * failed, or SPF/DKIM failed with nothing passing. A message without
 * the header is not refused (the server may not add one); the From
 * line is then the only check, which the README says plainly.
 */
export function senderFailedAuth(authResults: string | null): boolean {
  if (!authResults) return false;
  const text = authResults.toLowerCase();
  if (/\bdmarc=fail\b/.test(text)) return true;
  const passed = /\b(?:spf|dkim)=pass\b/.test(text);
  const failed = /\b(?:spf|dkim)=(?:fail|softfail)\b/.test(text);
  return failed && !passed;
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
