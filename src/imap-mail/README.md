# IMAP mail trigger

Status: current
Owner: src/imap-mail/

A task from a mail in the operator's own mailbox (ATO-601): Gmail with an app password, Fastmail, iCloud or any IMAP server over implicit TLS. The sibling of the [Atomic Mail trigger](../atomic-mail/README.md), with the same sender rules and the same task message, so the desktop's mail cards show both. No new dependencies: the client is Node `tls` ([imap-client.ts](imap-client.ts)) and MIME reading reuses the `.eml` reader of `read_document`.

```json
"webhooks": {
  "gmail": {
    "source": "imap",
    "userMessageTemplate": "Handle this e-mail from {{body.from}}.",
    "email": { "allowedSenders": ["me@gmail.com"], "pollIntervalMs": 60000 },
    "imap": { "host": "imap.gmail.com", "user": "me@gmail.com", "passwordEnv": "GMAIL_APP_PASSWORD" }
  }
}
```

Put the app password in `~/.atomic-agent/.env` (`GMAIL_APP_PASSWORD=...`). `auth: "xoauth2"` sends an OAuth access token from the same variable instead; nothing here runs an OAuth flow or refreshes a token.

- Off unless a binding declares `source: "imap"`, `tasks.enabled` is on and `email.allowedSenders` is not empty. Runs only in the process that leads the scheduler.
- [imap-mail-trigger.ts](imap-mail-trigger.ts): only unread mail above the last handled UID is read. The first contact, a new mailbox or a new UIDVALIDITY skips what is already there. State: `<stateDir>/imap-mail-trigger.json` (0600).
- Headers are read first. A sender off the list or not authenticated (topmost `Authentication-Results`, see the Atomic Mail README; with `imap.authservId`, which defaults to `mx.google.com` for Gmail, the header must also carry that id) is logged and left untouched: not downloaded, not marked read.
- A task starts by itself only when the sender is the mailbox's own address AND `imap.authservId` is set (default `mx.google.com` for `imap.gmail.com`). For any other host without `imap.authservId`, every task is created paused: the topmost `Authentication-Results` could have been written by the sender, not your server. Set `imap.authservId` to your provider's id (the first token of the `Authentication-Results` header it adds) to allow auto-start.
- The sender address is read outside quoted names, comments and encoded words; a From with more than one address is refused.
- Only mail from your own address starts its task at once: by default the mailbox's login when it is an address, else `email.autoStartSenders` (see the Atomic Mail README; that address is allowed even when not in `allowedSenders`). A task from any other allowed sender is created paused and waits for you to start it.
- A mail that became a task is marked `\Seen` (`imap.markSeen`, default on). At most 5 tasks per pass.
- Push: `imap.idle` (default on) keeps one IDLE connection per binding and handles new mail at once, re-polling every 10 minutes. No IDLE on the server, or a dropped line, falls back to polling every `email.pollIntervalMs`, and IDLE is retried with a back-off. The connection closes when scheduler ticks stop (another process took the lead).
- Attachments ([imap-attachments.ts](imap-attachments.ts)) land in `<stateDir>/inbox/email/<binding>/<day>/`, like the chat channels' files, and the task message lists their paths. Limits: `imap.attachments.maxCount` (10), `maxBytes` per file (10 MB), `maxTotalBytes` per mail (25 MB). Programs, scripts, installers, disk images and macro documents are never saved; the list says so.

Not covered: replies by mail (`replyByEmail` is refused for this source: no SMTP client yet), STARTTLS on port 143, non-ASCII folder names, Gmail API with OAuth sign-in, a settings screen.

Checks: `npx vitest run src/imap-mail src/config/imap-trigger-config.test.ts`; `npm run lint`; `npm run docs:check`.
