# Remote chat adapters

Status: current
Owner: src/channels/

This area owns remote chat adapters. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [model-command.ts](model-command.ts)
- [chat-session-map.ts](chat-session-map.ts)
- [reconnect-backoff.ts](reconnect-backoff.ts)
- [telegram-channel.ts](telegram/telegram-channel.ts)
- [discord-channel.ts](discord/discord-channel.ts)

## Ownership and dependencies

Each channel adapter owns its connection, pairing/control state and outbound delivery. Inbound handlers translate messages into runtime turns or durable tasks; approval bridges route decisions to the owning session. Shared backoff and sender identity helpers are used across transports. Runtime owns construction and teardown. Model commands use [shared provider persistence](../config/llm-provider-commands.ts), independently of TUI.

## Task-specific reading

Read docs/adapters.md for Telegram/Discord/Swarm changes; ../approval/AGENTS.md and ../runtime/AGENTS.md for routing.

## Validation

`npx vitest run src/channels`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
