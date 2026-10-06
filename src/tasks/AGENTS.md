# Durable task queue

Scope: `src/tasks/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- Preserve durable claim/recover/retry transitions and per-session FIFO. A recurring completion requeues while preserving its session; do not make completion an unconditional terminal deletion.
- Keep scheduled work routed through runTurn. Shutdown drains owned work before closing the task store; reports reflect actual terminal outcomes.
- Schedules, wake reasons, webhook ingress and report destinations are explicit state, not implicit timers in UI components.

## Read when relevant

Read docs/queue.md and ../scheduler/README.md for schedule/drain edits; ../http/AGENTS.md for webhooks.

## Checks

Run `npx vitest run src/tasks` for affected behavior and `npm run lint`. For documentation run `npm run docs:check`. Use narrower existing test files for a small change; cross-domain contracts require their seam tests.
