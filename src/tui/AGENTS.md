# Terminal interface

Scope: `src/tui/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- Keep reducers pure and external work in orchestrators. Session-scoped live events must not leak into the selected chat; preserve reload rendering and turn marks.
- Keyboard and mouse interactions must use the same state transitions. Preserve terminal modes, selection passthrough, modal precedence and restoration on exit.
- Public commands must retain live provider switching, approvals, attachments and cancellation behavior. UI display must not invent successful checks or worker attribution.
- Feature views/helpers live with their owners; use README.md for local state/input/orchestrators and global composition seams. Keep shared primitives independent of feature implementations; components/ also contains intentional shell composition. Directory moves do not authorize behavior changes.

## Read when relevant

Read docs/interface.md for input/layout/orchestrator edits; the underlying domain AGENTS.md when changing its settings or operations.

## Checks

Run `npx vitest run src/tui` for affected behavior and `npm run lint`. For documentation run `npm run docs:check`. Use narrower existing test files for a small change; cross-domain contracts require their seam tests.
