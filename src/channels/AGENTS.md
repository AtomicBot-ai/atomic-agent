# Remote chat adapters

Scope: `src/channels/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- Keep sender identity/pairing, session mapping and approval routing isolated. Channels invoke runTurn and must handle steer returning false by their documented queue policy.
- Preserve channel-specific polling/reconnect lifecycle and cleanup. Telegram polling is a scoped timer exception, not permission for general polling.
- Preserve text formatting, length limits, retry boundaries and attachment delivery. Task reports must go to the configured owner, not an arbitrary chat.
- Keep tokens out of logs and persisted session text; use settings/secret resolution paths.

## Read when relevant

Read docs/adapters.md for Telegram/Discord/Swarm changes; ../approval/AGENTS.md and ../runtime/AGENTS.md for routing.

## Checks

Run `npx vitest run src/channels` for affected behavior and `npm run lint`. For documentation run `npm run docs:check`. Use narrower existing test files for a small change; cross-domain contracts require their seam tests.
