# Offline mode (network kill switch)

Status: current (ATO-1084)
Owner: src/llm/ ([offline-network.ts](../offline-network.ts))

Offline mode makes the agent refuse every outbound connection whose host is not this machine. `localhost`, `127.0.0.0/8` and `::1` stay reachable, so local models, the managed llama-server and Atomic Core, and local http MCP servers keep working. Everything else fails with `offline mode: <host> blocked`. It is off by default.

## Turning it on

- Config: `network.offline: true` (`atomic-agent config set network.offline true`). Applied when a runtime starts.
- Environment: `ATOMIC_AGENT_OFFLINE=1` turns it on for that process from its first request, whatever the file says, and it cannot be turned off for that process.
- Live: `runtime.offlineMode.setEnabled(on)` persists `network.offline` and applies it to the next request. The HTTP server exposes it as `GET /api/offline-mode` and `POST /api/offline-mode` with `{ "enabled": true }`; both answer `{ enabled, egress }`.

## What is enforced

- Every `fetch` in the process: the global undici dispatcher installed by [transport-deadlines.ts](../transport-deadlines.ts) is composed with `offlineNetworkInterceptor`, which refuses a non-loopback origin before any DNS lookup or connection. That covers cloud LLM providers, model and engine downloads, update checks, skill and plugin hubs, Discord's REST API, remote MCP servers, PostHog and Sentry.
- Anonymous analytics and crash reports are not even built while offline mode is on at start (`isAnalyticsKilledByEnv`). Clients built before a live switch-on are refused by the dispatcher.
- `os.web.fetch`, `os.http.request` and `os.web.search` run curl, which the dispatcher cannot see; each refuses with a tool error before approval, DNS or curl. `runCurl` refuses a remote URL argument as a backstop.
- Browser tools: `browser.navigate`, `browser.tabs` new and `browser.search` refuse a remote URL, and a click or redirect that lands on a remote page clears the tab. A Chrome the agent starts while offline gets `--proxy-server=http://127.0.0.1:9`, so pages, subresources and Chrome's own background requests fail; Chrome never proxies loopback.
- Remote MCP transports (`streamable_http`, `sse`) are refused before connecting unless the URL is on this machine.
- Subscription CLI providers (Claude Code, Codex) are separate programs that talk to their vendor's cloud; they are refused before they start.
- The Telegram bot uses grammy's own HTTP client (node-fetch), so the bot factory refuses to start it. A live switch-on stops Telegram, Discord and swarm bots; switching off starts the ones their config enables.

## What is not enforced

Without an OS sandbox nothing in this process can stop another program from opening a socket. These stay able to reach the network while offline mode is on:

- shell commands (`os.shell.*`), `git` and anything they start;
- stdio MCP servers, which are child processes;
- a Chrome the agent attached to rather than started (`browser.cdpUrl`, `browser.connect: "user-chrome"`), and Chrome's WebRTC/UDP traffic, which a proxy does not cover; only the URL gate applies there;
- a Chrome the agent started before offline mode was switched on live; only the URL gate applies until it is restarted.

## Egress counter

`egressSnapshot()` (and `runtime.offlineMode.egress()`) returns `{ bytesOut, requestsOut, requestsBlocked, since }` for this process. `bytesOut` counts the request path and body bytes undici sends to non-loopback hosts through the dispatcher; it does not include headers, TLS overhead or traffic from child processes. `requestsBlocked` counts every refusal above. The counters reset when offline mode turns on.
