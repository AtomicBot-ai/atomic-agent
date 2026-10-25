# Approval policy and routing

Scope: `src/approval/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- Preserve levels, per-session grants and explicit approval routing. A host handler must be cleared when its session ownership ends.
- Dangerous-tool wrappers and read-scope checks remain dispatch guards. Do not broaden a grant by changing only prompt text or readonly metadata.
- A session grant may be recorded from the TUI, the CLI prompt, the desktop app and the owner's Telegram chat (issue #230). Every surface offers it only through `canGrantCategory` / `canGrantShape` and re-checks the scope against the pending request when the answer comes back. A grant stays in-memory and keyed by session id, never covers a category `isGrantableCategory` rejects (`trust_config`, `email`, `fusion_fanout`), never skips a hardline shell-guard block, and never moves the standing level, which only the computer itself can change.
- Fusion workers have no interactive approval surface; preserve their refusal posture rather than parking an invisible request.

## Read when relevant

Read README.md, ../tools/docs/contracts.md and ../runtime/docs/lifecycle.md before approval/read-scope changes.

## Checks

Run `npx vitest run src/approval` for affected behavior and `npm run lint`. For documentation run `npm run docs:check`. Use narrower existing test files for a small change; cross-domain contracts require their seam tests.
