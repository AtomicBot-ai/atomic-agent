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
    "email": { "allowedSenders": ["boss@example.com", "@mycompany.com"], "pollIntervalMs": 60000, "replyByEmail": false }
  }
}
```

- `allowedSenders` is required; an empty list keeps the trigger off. Mail from anyone else, from the agent's own address, or failing DMARC/SPF/DKIM per the server's `Authentication-Results` is ignored. Without that header the From line is the only check.
- The first poll marks mail already in the inbox as seen; old mail is never replayed. State: `<stateDir>/atomic-mail-trigger.json`.
- The template sees only `{{body.from}}` and `{{body.receivedAt}}`. Subject and body follow it inside an untrusted-content fence.
- At most 5 tasks per poll; the binding is not reachable over `POST /api/webhooks/<name>`.
- `replyByEmail: true` mails the agent's final answer back to the sender when the task ends.

Not covered yet: IMAP or Gmail for the operator's own mailbox (needs new dependencies), JMAP push instead of polling.
