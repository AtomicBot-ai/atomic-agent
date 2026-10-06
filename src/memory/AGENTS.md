# Durable cross-session memory

Scope: `src/memory/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- Keep durable memory outside the model. Reads refresh turn context; memory writes must not change the stable prefix. Let prompt assembly own section placement.
- Notes content remains append-only through tag evolution; profile facts have temporal history. Preserve dedup, bounds, leases and durable lesson/procedure lifecycle.
- Optional embedding/sub-call failures must retain the documented fallback; isolate sub-call provider/session/slot state from the user turn.
- Consult current config defaults: rewriter is enabled, typedNotes and segmentation are disabled. Archive rollout flags are not current defaults.

## Read when relevant

Read docs/retrieval.md for recall and docs/formation.md for reflection/consolidation; ../prompt/AGENTS.md for rendering.

## Checks

Run `npx vitest run src/memory` for affected behavior and `npm run lint`. For documentation run `npm run docs:check`. Use narrower existing test files for a small change; cross-domain contracts require their seam tests.
