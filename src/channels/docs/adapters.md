# Telegram, Discord and Swarm adapters

Status: current
Owner: src/channels/

Channels connect remote messages to the same session/turn runtime. Sender identity, pairing and persisted chat/session pointers must be scoped to the adapter and owner. Approvals are routed to that session's chat surface; invisible fusion workers cannot wait for them. The Telegram approval message shows every line of the preview while it fits in one message; a longer one keeps whole lines from the top and ends with "+N more lines" rather than failing to send.

Telegram uses grammy polling with explicit start/stop/reconnect ownership and HTML formatting with safe fallback/chunking. Telegram pairing ([pairing-mode](../telegram/pairing-mode.ts)) opens a 5-minute window with a fresh 6-digit one-time code that only the operator's screen sees (`startPairing` hands it to `onOpened`; it is never logged or put in shared snapshots). Only a private DM `/start <code>` claims it; a wrong code is swallowed, any other DM meets the normal owner check. While an owner is configured, `startPairing` refuses unless the caller passes the operator's confirmation (`replaceOwner`); the TUI asks for it by a second press within 15 seconds. An HTTP client (the desktop) pairs through `POST /api/telegram/pairing`, the only reply that carries the code, confirms a replacement with `replaceOwner: true` and polls `GET` for the claim ([route](../../http/route-telegram-pairing.ts)). The claim carries the new owner's @username for the confirmation line ([pairing-copy](../telegram/pairing-copy.ts)). Discord owns its gateway transport and output formatting. Preserve file ingestion/delivery, retries, task-report destination and configured live enable/disable behavior. Swarm manages additional bot instances rather than replacing primary channel ownership.

Shared model commands currently import provider persistence from TUI; stage 02 moves that responsibility. Do not describe this boundary as already repaired.

Sources: [Telegram](../telegram/telegram-channel.ts), [Discord](../discord/discord-channel.ts), [Swarm](../swarm/swarm-registry.ts), [model commands](../model-command.ts), [backoff](../reconnect-backoff.ts). Tests: [Telegram](../telegram/telegram-channel.test.ts), [Discord](../discord/discord-channel.test.ts), [model commands](../telegram/inbound-model-command.test.ts).
