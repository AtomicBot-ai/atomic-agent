import { AtomicMailError } from "./atomic-mail-auth.js";
import type { InboxMessage, SendMailInput } from "./atomic-mail-client.js";

/**
 * The JMAP method batches the client sends, and how their answers are
 * read — pure, so a test can pin the exact wire shape without a fake
 * server.
 */

/** `Email/set` (a draft) + `EmailSubmission/set` (send it) in one round trip. */
export function buildSendBatch(
  accountId: string,
  from: string,
  draftsMailboxId: string,
  mail: SendMailInput,
  identityId: string | null = null,
): unknown[] {
  const bodyValues: Record<string, { value: string }> = { t: { value: mail.text } };
  if (mail.html) bodyValues.h = { value: mail.html };
  return [
    [
      "Email/set",
      {
        accountId,
        create: {
          d1: {
            mailboxIds: { [draftsMailboxId]: true },
            from: [{ email: from, name: "Atomic Agent" }],
            to: [{ email: mail.to }],
            subject: mail.subject,
            textBody: [{ partId: "t", type: "text/plain" }],
            ...(mail.html ? { htmlBody: [{ partId: "h", type: "text/html" }] } : {}),
            bodyValues,
            keywords: { $draft: true, $seen: true },
          },
        },
      },
      "c0",
    ],
    [
      "EmailSubmission/set",
      {
        accountId,
        create: {
          s1: {
            emailId: "#d1",
            ...(identityId ? { identityId } : {}),
            envelope: { mailFrom: { email: from }, rcptTo: [{ email: mail.to }] },
          },
        },
        onSuccessUpdateEmail: { "#s1": { "keywords/$draft": null } },
      },
      "c1",
    ],
  ];
}

export function parseSendResult(responses: unknown[]): string {
  const typed = responses as [string, Record<string, unknown>][];
  const draft = typed.find(([name]) => name === "Email/set")?.[1] as
    | { notCreated?: Record<string, { type?: string; description?: string }> }
    | undefined;
  const draftWhy = draft?.notCreated?.d1;
  if (draftWhy) {
    throw new AtomicMailError("the draft was not accepted", 0, draftWhy.description ?? draftWhy.type);
  }
  const submission = typed.find(
    ([name]) => name === "EmailSubmission/set",
  )?.[1] as
    | {
        created?: Record<string, { id?: string }>;
        notCreated?: Record<string, { type?: string; description?: string }>;
      }
    | undefined;
  const id = submission?.created?.s1?.id;
  if (!id) {
    const why = submission?.notCreated?.s1;
    throw new AtomicMailError("send was not accepted", 0, why?.description ?? why?.type);
  }
  return id;
}

/** Newest `limit` messages of a mailbox, with the fields the inbox tool shows. */
export function buildInboxBatch(accountId: string, mailboxId: string, limit: number): unknown[] {
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
        properties: ["id", "from", "subject", "receivedAt", "preview", "keywords"],
      },
      "g",
    ],
  ];
}

export function parseInboxList(responses: unknown[]): InboxMessage[] {
  const got = (responses as [string, Record<string, unknown>][]).find(([name]) => name === "Email/get")?.[1] as
    | { list?: Array<Record<string, unknown>> }
    | undefined;
  return (got?.list ?? []).map((m) => {
    const from = (m.from as Array<{ email?: string; name?: string }> | undefined)?.[0];
    const keywords = (m.keywords as Record<string, boolean> | undefined) ?? {};
    return {
      id: String(m.id ?? ""),
      from: from?.name ? `${from.name} <${from.email ?? ""}>` : (from?.email ?? ""),
      subject: String(m.subject ?? ""),
      receivedAt: String(m.receivedAt ?? ""),
      preview: String(m.preview ?? ""),
      unread: keywords.$seen !== true,
    };
  });
}
