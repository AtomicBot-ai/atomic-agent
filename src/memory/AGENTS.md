# Durable cross-session memory

Scope: `src/memory/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- Keep durable memory outside the model. Reads refresh turn context; memory writes must not change the stable prefix. Let prompt assembly own section placement.
- Notes content remains append-only through tag evolution (the one exception is the person's own edit, `MemoryStore.updateContent` behind `PATCH /api/memory/notes/{id}`); profile facts have temporal history. Note edits and deletions and profile deletions go into `memory_change_log` (evolution/memory-change-log.ts) so one change can be undone. Preserve dedup, bounds, leases and durable lesson/procedure lifecycle.
- Optional embedding/sub-call failures must retain the documented fallback; isolate sub-call provider/session/slot state from the user turn.
- Consult current config defaults: rewriter is enabled, typedNotes and segmentation are disabled. Archive rollout flags are not current defaults.

## Read when relevant

Read docs/retrieval.md for recall and docs/formation.md for reflection/consolidation; ../prompt/AGENTS.md for rendering.

## Checks

Run `npx vitest run src/memory` for affected behavior and `npm run lint`. For documentation run `npm run docs:check`. Use narrower existing test files for a small change; cross-domain contracts require their seam tests.
