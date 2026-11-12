/**
 * The JMAP batch the mail trigger (ATO-601) reads the inbox with, and
 * how its answer is read. Unlike the inbox tool's listing it asks for
 * the plain-text body (capped) and the receiving server's
 * `Authentication-Results` header, so the trigger can hand the task the
 * whole message and refuse one whose sender failed SPF/DKIM/DMARC.
 * Pure, so the wire shape is pinned without a fake server.
 */

/** One inbox message as the trigger sees it. All text is the sender's. */
export interface TriggerMail {
  id: string;
  /** Bare address, lower-cased; `""` when the message has none. */
  fromEmail: string;
  fromName: string;
  subject: string;
  receivedAt: string;
  /** Plain-text body (capped at {@link TRIGGER_BODY_MAX_BYTES}), else the preview. */
  text: string;
  /** Raw `Authentication-Results` header(s), `null` when the server added none. */
  authResults: string | null;
}

/** Body bytes asked for per message; the task message has its own cap too. */
export const TRIGGER_BODY_MAX_BYTES = 12_000;

const AUTH_RESULTS_PROPERTY = "header:Authentication-Results:asText:all";

export function buildTriggerInboxBatch(
  accountId: string,
  mailboxId: string,
  limit: number,
): unknown[] {
  return [
    [
      "Email/query",
      {
        accountId,
        filter: { inMailbox: mailboxId },
        sort: [{ property: "receivedAt", isAscending: false }],
        limit,
      },
      "q",
    ],
    [
      "Email/get",
      {
        accountId,
        "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties: [
          "id",
          "from",
          "subject",
          "receivedAt",
          "preview",
          "textBody",
          "bodyValues",
          AUTH_RESULTS_PROPERTY,
        ],
        fetchTextBodyValues: true,
        maxBodyValueBytes: TRIGGER_BODY_MAX_BYTES,
      },
      "g",
    ],
  ];
}

function bodyText(m: Record<string, unknown>): string {
  const parts = (m.textBody as Array<{ partId?: string }> | undefined) ?? [];
  const values =
    (m.bodyValues as Record<string, { value?: unknown }> | undefined) ?? {};
  const text = parts
    .map((p) => (p.partId ? values[p.partId]?.value : undefined))
    .filter((v): v is string => typeof v === "string")
    .join("\n\n")
    .trim();
  return text.length > 0 ? text : String(m.preview ?? "");
}

function authResults(m: Record<string, unknown>): string | null {
  const raw = m[AUTH_RESULTS_PROPERTY];
  if (typeof raw === "string") return raw.trim() || null;
  if (Array.isArray(raw)) {
    const joined = raw.filter((v) => typeof v === "string").join("\n").trim();
    return joined || null;
  }
  return null;
}

/** Messages newest first, as the server sorted them. */
export function parseTriggerInbox(responses: unknown[]): TriggerMail[] {
  const got = (responses as [string, Record<string, unknown>][]).find(
    ([name]) => name === "Email/get",
  )?.[1] as { list?: Array<Record<string, unknown>> } | undefined;
  return (got?.list ?? []).map((m) => {
    const from = (
      m.from as Array<{ email?: string; name?: string }> | undefined
    )?.[0];
    return {
      id: String(m.id ?? ""),
      fromEmail: String(from?.email ?? "").trim().toLowerCase(),
      fromName: String(from?.name ?? ""),
      subject: String(m.subject ?? ""),
      receivedAt: String(m.receivedAt ?? ""),
      text: bodyText(m),
      authResults: authResults(m),
    };
  });
}
