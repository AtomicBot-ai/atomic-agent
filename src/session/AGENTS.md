# Session state and persistence

Scope: `src/session/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- A session is a multi-turn chat. reply closes a macro-turn; finish closes the session. Preserve transcript tool-call/result pairing and attach one inference reasoning block once.
- Keep loaded tools/skills, recalled state and conversation pack boundaries in explicit session state. Do not reclassify stalled as successful or change cancellation exit semantics casually.
- Preserve turn-owner stamps, interrupted-turn persistence, retention protection of active work and summary/title behavior.

## Read when relevant

Read README.md for state/retention changes; ../runtime/docs/lifecycle.md for concurrency and shutdown.

## Checks

Run `npx vitest run src/session` for affected behavior and `npm run lint`. For documentation run `npm run docs:check`. Use narrower existing test files for a small change; cross-domain contracts require their seam tests.
