# NDJSON sidecar

Status: current
Owner: src/sidecar/

Owns stdin/stdout transport and host event forwarding. Preserve protocol shapes, request/session ownership and the already-acquired turn lock seam.

Entry point: [main.ts](main.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

`skill_list` uses the active cloud session's workspace and includes disabled reasons and selected source paths. Independent local sessions retain their existing registry. See [cloud workspace](../runtime/docs/cloud-workspace.md).

Checks: `npx vitest run src/sidecar` when tests are present; `npm run lint`; `npm run docs:check`.

Context controls: `compact_session` and `get_compaction` take `{sessionId}` and use normal response correlation. Session compaction lifecycle and part-progress events are forwarded with their session ID. `send_message` reloads saved state inside its existing FIFO lock, preserving checkpoints written between turns. See [context compaction](../runtime/docs/compaction.md).
