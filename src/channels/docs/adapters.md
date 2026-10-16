# Telegram, Discord and Swarm adapters

Status: current
Owner: src/channels/

Channels connect remote messages to the same session/turn runtime. Sender identity, pairing and persisted chat/session pointers must be scoped to the adapter and owner. Approvals are routed to that session's chat surface; invisible fusion workers cannot wait for them.

Telegram uses grammy polling with explicit start/stop/reconnect ownership and HTML formatting with safe fallback/chunking. Discord owns its gateway transport and output formatting. Preserve file ingestion/delivery, retries, task-report destination and configured live enable/disable behavior. Swarm manages additional bot instances rather than replacing primary channel ownership.

The Telegram approval keyboard can record a session grant (issue #230): next to Approve / Deny it offers a category row when `canGrantCategory` allows one and a command-shape row when `canGrantShape` does. This is a threat-model decision, not a missed wire-up: the earlier rule was that only the TUI and the CLI, which have physical machine access, could grant. A remote chat can now raise trust for the rest of one session. The limits are unchanged: a grant is in-memory and session-scoped, cannot cover `trust_config`, cannot bypass the hardline shell guard, and cannot move the standing level, which stays TUI/CLI-only. The bridge re-checks the scope against the retained request when the button comes back, so the toast reports only a grant the gate kept.

Shared model commands currently import provider persistence from TUI; stage 02 moves that responsibility. Do not describe this boundary as already repaired.

Sources: [Telegram](../telegram/telegram-channel.ts), [approval bridge](../telegram/approval-bridge.ts), [Discord](../discord/discord-channel.ts), [Swarm](../swarm/swarm-registry.ts), [model commands](../model-command.ts), [backoff](../reconnect-backoff.ts). Tests: [Telegram](../telegram/telegram-channel.test.ts), [approval bridge](../telegram/approval-bridge.test.ts), [Discord](../discord/discord-channel.test.ts), [model commands](../telegram/inbound-model-command.test.ts).
