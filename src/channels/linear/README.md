# Linear channel

Status: current
Owner: src/channels/linear/

Mention the agent in a Linear issue comment, or assign it the issue, and it starts working and answers as a comment in the same thread (ATO-2324). Each issue is one conversation: later mentions on the same issue continue the same session (`<stateDir>/linear-session.json`). The channel never edits an issue on its own; changing a status is a tool call, which goes through the approval gate, and the approval prompt arrives as a comment you answer with `yes <code>` or `no <code>`.

Linear talks to a small endpoint on your machine through a webhook. Atomic Agent runs no relay. The channel is off by default and only answers the Linear users you list as owners. Same design as the Cline CLI Linear connector (Apache-2.0): signed webhook in, GraphQL `commentCreate` out.

## 1. Create an API key and a webhook in Linear

1. Linear, Settings, Account, Security & access, **Personal API keys**: create a key (`lin_api_...`). The agent posts its comments as this key's user. A separate Linear member for the agent (for example "Atomic Agent") keeps its comments apart from yours; your own key works too.
2. Linear, Settings, API, **Webhooks**, New webhook: URL is your public tunnel URL plus `/linear/webhook` (step 3), resource types **Comments** and **Issues**. Copy the **signing secret** (shown once).

## 2. Configure Atomic Agent

Secrets go in `<stateDir>/.env` (normally `~/.atomic-agent/.env`), never in `config.json`:

```
LINEAR_API_KEY=lin_api_...
LINEAR_WEBHOOK_SECRET=lin_wh_...
```

Then in `config.json`:

```json
{
  "channels": {
    "linear": {
      "enabled": true,
      "ownerIds": ["<your Linear user id>"],
      "options": { "port": 3979, "mention": "agent" }
    }
  }
}
```

- `ownerIds`: Linear user ids allowed to drive the agent. An empty list refuses everyone. The id is easiest to get from the log: mention the agent once, and the channel logs `linear: dropping mention from non-owner` with your `userId`.
- `mention`: the handle(s) that address the agent, comma separated, without `@`. Default `agent`, so `@agent please triage this` works. Linear profile links (`https://linear.app/<org>/profiles/<handle>`) count too, so mentioning the agent's Linear member by name works when `mention` is its username.
- `onAssign`: start work when an issue is assigned to the API key's user. Default: on when the key belongs to a separate agent member, off when the key is one of the owners' own (assigning yourself an issue would otherwise start the agent).
- `port` defaults to 3979; the endpoint binds `127.0.0.1` only.

## 3. Expose the endpoint with your own tunnel

Linear must reach `http://127.0.0.1:3979/linear/webhook` over public HTTPS, for example:

- Cloudflare Tunnel: `cloudflared tunnel --url http://127.0.0.1:3979` (a named tunnel keeps the URL stable).
- ngrok: `ngrok http 3979`.

Every request is checked before its body is read: `Linear-Signature` must be the HMAC-SHA256 of the exact body with your signing secret, and `webhookTimestamp` must be within one minute of now. Anything else gets a 401. A repeated `Linear-Delivery` id runs once. A quick tunnel URL changes on every restart; update the webhook URL when it does.

## 4. Try it

1. Start the agent (`atag serve`, the TUI, or the desktop app) with the channel enabled.
2. In a test issue, comment `@agent summarize this issue and suggest next steps`.
3. The agent answers as a reply in that comment thread. Mention it again on the same issue and it remembers the earlier exchange.
4. A forged request is refused: `curl -X POST -H 'Linear-Signature: 00' -d '{}' http://127.0.0.1:3979/linear/webhook` answers 401.

## Commands, queue and files (ATO-2464)

- `@agent /status` says which session the issue is on, whether a request runs or waits, and how many approvals wait. `@agent /new` archives the issue's session so the next mention starts fresh (refused while a request runs). `@agent /cancel` (or `/stop`) stops the running request and the ones queued on the issue. `@agent /help` lists them. As on Discord, a lone `stop`, `cancel` or `status` after the mention counts too; "@agent stop the deploy" is still a request ([linear-commands.ts](linear-commands.ts)).
- A mention on an issue the agent is still answering is queued, not refused: the comment "Queued: ..." says so, and the requests run in order. At most 4 requests per issue are held, the running one included ([linear-turn-queue.ts](linear-turn-queue.ts)).
- Files attached to the comment that mentions the agent (Linear uploads, `https://uploads.linear.app/...`) are downloaded with the API key and saved to `<stateDir>/inbox/linear/<date>/`; the agent gets their local paths like files sent on Telegram or Discord. Up to 5 files and 25 MB each; the key is sent to `uploads.linear.app` only, never along a redirect ([linear-attachments.ts](linear-attachments.ts)).

## Not yet supported

Linear Agent sessions (`AgentSessionEvent`, the "agent" app actor) and polling without a public URL.

## Files

- [index.ts](index.ts): the catalog entry and exports.
- [linear-channel.ts](linear-channel.ts): lifecycle, lock, loop guard and approval routing.
- [linear-server.ts](linear-server.ts) and [linear-signature.ts](linear-signature.ts): the signed endpoint.
- [linear-inbound-handler.ts](linear-inbound-handler.ts) and [linear-mention.ts](linear-mention.ts): what starts a turn.
- [linear-api.ts](linear-api.ts): `viewer` and `commentCreate`.
- [linear-approval-bridge.ts](linear-approval-bridge.ts): approvals as comments.
- [linear-commands.ts](linear-commands.ts), [linear-turn-queue.ts](linear-turn-queue.ts), [linear-attachments.ts](linear-attachments.ts): comment commands, the per-issue queue, uploads.
