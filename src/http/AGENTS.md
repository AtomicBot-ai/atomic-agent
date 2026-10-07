# HTTP and OpenAI-compatible ingress

Scope: `src/http/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- Keep auth, request limits and approval routing at ingress. Preserve the host runTurn/FIFO contract and session-scoped event hooks.
- Client disconnect and explicit cancellation must abort the owned turn. Steering that loses the race with turn completion must not silently lose the message.
- Preserve streaming commitment, frames and public response/error shapes. Do not log request credentials.

## Read when relevant

Read README.md and ../runtime/docs/lifecycle.md for session/stream/steering changes.

## Checks

Run `npx vitest run src/http` for affected behavior and `npm run lint`. For documentation run `npm run docs:check`. Use narrower existing test files for a small change; cross-domain contracts require their seam tests.
