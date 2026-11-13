# Atomic Mail

Status: current
Owner: src/atomic-mail/

Owns agent inbox registration, owner verification, sending and reading through JMAP. Preserve owner-code verification, credential storage and approval posture; do not silently mail an unverified owner.

Entry point: [atomic-mail-service.ts](atomic-mail-service.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/atomic-mail` when tests are present; `npm run lint`; `npm run docs:check`.

## Task from an incoming e-mail (ATO-601)

[atomic-mail-trigger.ts](atomic-mail-trigger.ts) turns new inbox messages into tasks. Off by default: it runs only for a `webhooks` binding with `"source": "atomic-mail"`, needs `tasks.enabled` and `tasks.schedulerEnabled`, and polls only in the process that leads the scheduler.

```json
"webhooks": {
  "inbox": {
    "source": "atomic-mail",
    "userMessageTemplate": "Handle this e-mail from {{body.from}}.",
    "email": { "allowedSenders": ["boss@example.com", "@mycompany.com"], "pollIntervalMs": 60000, "replyByEmail": false, "trustFromHeader": false }
  }
}
```

- `allowedSenders` is required; an empty list keeps the trigger off. Mail from anyone else or from the agent's own address is ignored.
- The From line alone is not trusted. Only the topmost `Authentication-Results` header counts (the inbox server writes it above anything the sender wrote; the agent has no record of Atomic Mail's authserv-id, so the topmost header is taken as the server's rather than matched by name). The mail needs `dmarc=pass`, or `spf=pass` / `dkim=pass` whose domain (`smtp.mailfrom`, `header.d`) is aligned with the From domain; `dmarc=fail` always refuses. Anything else, including mail with no such header, is dropped and logged (`mail trigger: message ignored`, with the reason).
- `trustFromHeader: true` (default `false`) turns that check off and accepts mail on the From line alone. Only for a server that adds no `Authentication-Results`; anyone can write any From line.
- The first poll marks mail already in the inbox as seen; old mail is never replayed. State: `<stateDir>/atomic-mail-trigger.json`.
- The template sees only `{{body.from}}` and `{{body.receivedAt}}`. Subject and body follow it inside an untrusted-content fence.
- At most 5 tasks per poll; the binding is not reachable over `POST /api/webhooks/<name>`.
- `replyByEmail: true` (default `false`) mails the agent's final answer back to the sender when the task ends. There is no prompt per reply: turning it on is the operator's consent.

Not covered yet: IMAP or Gmail for the operator's own mailbox (needs new dependencies), JMAP push instead of polling.
