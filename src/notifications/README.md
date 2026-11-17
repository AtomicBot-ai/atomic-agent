# Notifications

Status: current
Owner: src/notifications/

Out-of-band pings that need no channel loop: a detached download worker reporting that a model landed, and phone push through ntfy (ATO-1129). Use recorded job outcomes, configured destinations and scrubbed errors.

Entry points:

- [download-notifier.ts](download-notifier.ts): one message on the channel a background download was armed with (`telegram`, `discord`, `email`, `push`).
- [ntfy-client.ts](ntfy-client.ts): `sendPush`, one JSON POST to `notifications.push.server` for `notifications.push.topic`, one attempt with an 8 s timeout, never throws. Title and body go through `maskSecrets` (the agent's `.env` values as known secrets) and are clipped to 200 characters. `generatePushTopic` mints the random topic: on ntfy.sh a topic is public by name. An optional access token is read from the env var named by `tokenEnv` (default `NTFY_TOKEN`).
- [push-messages.ts](push-messages.ts): the words of each push (turn end, approval waiting, task report, download). Only the agent's answer, never tool output or an approval preview.
- [push-setup.ts](push-setup.ts): `push on` / `off` persistence, shared by `atomic-agent push` and the TUI download prompt.
- [push-task-report.ts](push-task-report.ts): the task report sink for `notify: "push"`; `src/runtime/composition/runtime-task-services.ts` routes per `TaskReport.notify`.

Not here yet: a tap-to-open link in the push (needs a reachable `atag serve` URL), and the desktop app's own push (`desktop/main/turn-notify.ts`).

Read the root instruction route and the underlying domain instructions before cross-domain changes.

Checks: `npx vitest run src/notifications` when tests are present; `npm run lint`; `npm run docs:check`.
