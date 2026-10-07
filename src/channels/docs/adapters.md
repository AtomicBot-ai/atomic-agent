# Telegram, Discord and Swarm adapters

Status: current
Owner: src/channels/

Channels connect remote messages to the same session/turn runtime. Sender identity, pairing and persisted chat/session pointers must be scoped to the adapter and owner. Approvals are routed to that session's chat surface; invisible fusion workers cannot wait for them.

Telegram uses grammy polling with explicit start/stop/reconnect ownership and HTML formatting with safe fallback/chunking. Discord owns its gateway transport and output formatting. Preserve file ingestion/delivery, retries, task-report destination and configured live enable/disable behavior. Swarm manages additional bot instances rather than replacing primary channel ownership.

Shared model commands currently import provider persistence from TUI; stage 02 moves that responsibility. Do not describe this boundary as already repaired.

Sources: [Telegram](../telegram/telegram-channel.ts), [Discord](../discord/discord-channel.ts), [Swarm](../swarm/swarm-registry.ts), [model commands](../model-command.ts), [backoff](../reconnect-backoff.ts). Tests: [Telegram](../telegram/telegram-channel.test.ts), [Discord](../discord/discord-channel.test.ts), [model commands](../telegram/inbound-model-command.test.ts).
