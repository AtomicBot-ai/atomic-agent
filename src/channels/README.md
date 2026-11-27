# Remote chat adapters

Status: current
Owner: src/channels/

This area owns remote chat adapters. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [channel.ts](channel.ts) — the shared `Channel` / `ChannelDefinition` interface
- [channel-catalog.ts](channel-catalog.ts) — the list of adapters beyond Telegram and Discord
- [channel-registry.ts](channel-registry.ts) and [build-extra-channels.ts](build-extra-channels.ts)
- [model-command.ts](model-command.ts)
- [model-switch.ts](model-switch.ts)
- [chat-session-map.ts](chat-session-map.ts)
- [channel-fork.ts](channel-fork.ts): `/fork`, the session copy shared by the Telegram and Slack commands (ATO-2235)
- [reconnect-backoff.ts](reconnect-backoff.ts)
- [telegram-channel.ts](telegram/telegram-channel.ts)
- [discord-channel.ts](discord/discord-channel.ts)
- [signal/index.ts](signal/index.ts) — Signal through a user-run signal-cli daemon
- [slack-channel.ts](slack/slack-channel.ts) and [slack/index.ts](slack/index.ts) (Slack, Socket Mode)
- [imessage-channel.ts](imessage/imessage-channel.ts) — iMessage on macOS through the external `imsg` CLI
- [matrix-channel.ts](matrix/matrix-channel.ts) — Matrix, unencrypted rooms (ATO-632)
- [googlechat-channel.ts](googlechat/googlechat-channel.ts) — Google Chat over Pub/Sub pull (ATO-506)
- [msteams-channel.ts](msteams/msteams-channel.ts) and [msteams/index.ts](msteams/index.ts) (Microsoft Teams, Bot Framework; setup in [docs/msteams.md](docs/msteams.md))
- [whatsapp-channel.ts](whatsapp/whatsapp-channel.ts) — WhatsApp through WhatsApp Web pairing (unofficial protocol, `baileys`; ATO-502)

## Ownership and dependencies

Each channel adapter owns its connection, pairing/control state and outbound delivery. Inbound handlers translate messages into runtime turns or durable tasks; approval bridges route decisions to the owning session. Shared backoff and sender identity helpers are used across transports. Runtime owns construction and teardown. Model commands use [shared provider persistence](../config/llm-provider-commands.ts), independently of TUI; the live switch itself ([model-switch.ts](model-switch.ts)) is shared with the HTTP `POST /api/llm/active` route.

## Task-specific reading

Read docs/adapters.md for Telegram/Discord/Swarm changes; ../approval/AGENTS.md and ../runtime/AGENTS.md for routing.

## Validation

`npx vitest run src/channels`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
