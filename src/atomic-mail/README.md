# Atomic Mail

Status: current
Owner: src/atomic-mail/

Owns agent inbox registration, owner verification, sending and reading through JMAP. Preserve owner-code verification, credential storage and approval posture; do not silently mail an unverified owner.

Entry point: [atomic-mail-service.ts](atomic-mail-service.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/atomic-mail` when tests are present; `npm run lint`; `npm run docs:check`.
