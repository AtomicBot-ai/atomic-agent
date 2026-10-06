# Runtime assembly and ownership

Scope: `src/runtime/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- Route public turns through the per-session TurnController FIFO. The sidecar can call executeTurn only inside a lock it already acquired; do not enqueue recursively.
- Keep event and approval routing scoped to the owning session. Independent sessions can run concurrently; shared browser state is still a shared resource.
- Preserve live provider/model resolution and shutdown ordering. Stop producers and settle owned work before closing stores. Clear listeners, timers and routing in cleanup.
- Memory sub-calls and fusion workers must keep their own provider/slot/session posture; do not silently inherit a different turn provider.

## Read when relevant

Read docs/lifecycle.md before changing ownership, shutdown or steering; ../llm/docs/fallback.md before changing fallback wiring.

## Checks

Run `npx vitest run src/runtime` for affected behavior and `npm run lint`. For documentation run `npm run docs:check`. Use narrower existing test files for a small change; cross-domain contracts require their seam tests.
