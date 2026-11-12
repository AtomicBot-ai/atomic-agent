# NDJSON sidecar

Status: current
Owner: src/sidecar/

Owns stdin/stdout transport and host event forwarding. Preserve protocol shapes, request/session ownership and the already-acquired turn lock seam.

Entry point: [main.ts](main.ts). Read the root instruction route and the underlying domain instructions before cross-domain changes.

`skill_list` uses the active cloud session's workspace and includes disabled reasons and selected source paths. Independent local sessions retain their existing registry. See [cloud workspace](../runtime/docs/cloud-workspace.md).

Checks: `npx vitest run src/sidecar` when tests are present; `npm run lint`; `npm run docs:check`.

Context controls: `compact_session` and `get_compaction` take `{sessionId}` and use normal response correlation. Session compaction lifecycle and part-progress events are forwarded with their session ID. `send_message` reloads saved state inside its existing FIFO lock, preserving checkpoints written between turns. See [context compaction](../runtime/docs/compaction.md).

`skill_install` security-scans the folder before copying ([install scan](../skills/docs/skill-format.md#install-security-scan)). A `caution` verdict fails the request (its message lists the findings summary and ends with `[scanId <id>]`) unless the payload has `confirm: "<id>"`; a `dangerous` one fails unless `acknowledgeRisk: "<id>"`. `true` or an older scan's id is not a yes.

Approvals ([approval-payload.ts](approval-payload.ts)): `approval_request` carries the prompt (`tool`, `category`, `reason`, `preview`, `affectedResources`), `commandShape`, `riskNote` / `riskLevel` when smart approval ran, and which remembered answers the request can take: `canSession`, `canShape`, `canAlways` and, when `canAlways`, `alwaysLabel`. `approval_response` takes `{approvalId, approved, reason?, grant?}` with `grant` one of `session` (the category for this chat), `shape` (this binary for this chat) or `always` (save an allow rule for the project). A grant the request cannot take fails the request and the approval stays pending (ATO-1270). A session grant can cover one site rather than the whole category: a browser submit or off-site request is granted per host (ATO-1181) and an HTTP request per origin (ATO-1182). Such a request carries `grantHost` (`shop.example`, `https://api.example.com`) so the host can label the choice; the response may echo it as `grantHost` with `grant: "session"`. The agent always takes the site from its own pending request, so the field cannot widen a grant: a `grantHost` that is not the request's own site, or one sent without `grant: "session"`, fails the request and it stays pending. Without `grantHost` a session grant behaves as before (ATO-1474).
