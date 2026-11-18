# Subscription OAuth primitives

Status: primitives (ATO-1451) plus EXPERIMENTAL ChatGPT (ATO-1448, ATO-1449, ATO-1453) and GitHub Copilot (ATO-462) sign-ins wired as provider kind `subscription-oauth`
Owner: src/llm/provider/subscription-oauth/

Generic OAuth 2.0 building blocks for signing in with a subscription account (ATO-1451), and on top of them one experimental use: a ChatGPT plan without the Codex CLI. The generic files have no built-in client id, endpoint, scope, redirect path or port: the caller passes all of them. Only Node built-ins are used (`node:http`, `node:crypto`).

## Experimental ChatGPT sign-in

Nadya's decision on ATO-1448 (17.11.2026): do it the way Codex does, labelled experimental; the Codex CLI path (`subscription-cli`) stays primary; no import from `~/.codex`.

- [chatgpt-codex.ts](chatgpt-codex.ts): the Codex values (client id, `auth.openai.com` endpoints, ports 1455/1457, `/auth/callback`, scopes, `chatgpt_account_id` claim), browser and device-code sign-in, and the refresher. Each constant names the openai/codex file it was copied from. Codex's device flow is OpenAI's own (JSON, `device_auth_id`), not RFC 8628, so it has its own code here instead of `device-code.ts`.
- [credential-store.ts](credential-store.ts): the token file `<stateDir>/auth/chatgpt.json`, written 0600 through `writeOwnerOnlyFileAtomicSync`, tightened with a warning when found wider, deleted on sign-out. Never in `config.json`.
- [chatgpt-responses.ts](chatgpt-responses.ts): the Responses API body the ChatGPT Codex backend takes (`store: false`, `stream: true`, `instructions`, no output cap) and its SSE events.
- [subscription-oauth-provider.ts](subscription-oauth-provider.ts): the `LlmProvider`. Sends `Authorization: Bearer` and `chatgpt-account-id` to `https://chatgpt.com/backend-api/codex/responses`. A 401 refreshes once and retries once; a second 401 or a refused refresh raises `ChatgptSignInRequiredError` ("run `atag login chatgpt`"), which the fallback chain treats like a signed-out CLI. `entry.baseUrl` is ignored so the tokens only go to the ChatGPT backend.
- [create-subscription-oauth-provider.ts](create-subscription-oauth-provider.ts): the factory `register-built-in-providers.ts` uses for kind `subscription-oauth`.

A config entry looks like `{ "id": "chatgpt-sub", "kind": "subscription-oauth", "subscriptionOauth": { "service": "chatgpt" } }`. Nothing defaults to it.

## Experimental GitHub Copilot sign-in

Nadya's decision on ATO-462 (18.11.2026): Copilot only, on this framework; not Claude, not Grok. Done the way every agent that offers Copilot does it (pi `github-copilot.ts`, opencode, OpenClaw, Hermes).

- [github-copilot.ts](github-copilot.ts): GitHub's RFC 8628 device flow (`github.com/login/device/code`, the Copilot editor's client id `Iv1.b507a08c87ecfe98`, scope `read:user`) through `device-code.ts`. GitHub answers a pending grant with HTTP 200 and an `error` field, so `githubDeviceFetch` hands the poller a 400 for it. The long-lived GitHub token is stored in `<stateDir>/auth/copilot.json`. Per request it is exchanged at `api.github.com/copilot_internal/v2/token` for a Copilot token (about 30 minutes), cached in memory only, shared by concurrent requests, fetched again a minute before expiry or after a 401.
- The provider is the ordinary OpenAI-compatible client (`OpenAiProvider`) with that token as its `apiKeySource`, the editor headers Copilot requires, and `https://api.githubcopilot.com/chat/completions` (no `/v1`, see `openai-chat-path.ts`). `entry.baseUrl` is ignored, so the tokens only go to GitHub's hosts.
- CLI: `atag login copilot`, `atag login status copilot [--json]`, `atag logout copilot` (`src/cli/login-copilot.ts`). Sign-out deletes the local file; the grant itself is revoked at github.com/settings/applications.

A config entry looks like `{ "id": "copilot-sub", "kind": "subscription-oauth", "subscriptionOauth": { "service": "copilot" } }`.

## Pieces

- [oauth-login.ts](oauth-login.ts): browser sign-in with PKCE (S256 challenge, random `state`). Starts a receiver and returns the authorization URL; the caller decides how to open it.
- [loopback-callback.ts](loopback-callback.ts): one-shot redirect receiver bound only to `127.0.0.1`, on a random or given port. A wrong `state` fails the attempt before any token request, a second hit gets 409, other paths get 404, and the server closes on success, failure, timeout or cancel. Pages never echo query values.
- [device-code.ts](device-code.ts): RFC 8628 device authorization grant for machines without a browser. Polling honors `interval`, adds 5 s on `slow_down`, keeps going on `authorization_pending`, stops on `expired_token`, `access_denied`, local expiry or the abort signal.
- [token-refresh.ts](token-refresh.ts): returns stored tokens, refreshing them when they expire within the skew (60 s by default). Concurrent callers share one refresh request. A refused refresh token (`invalid_grant` and friends) raises `SignInRequiredError`; other failures raise `OAuthFlowError` so a retry stays possible. A response without a new refresh token keeps the old one.
- [logout.ts](logout.ts): deletes tokens through the injected `TokenStore`; optional revocation is best effort and never blocks the delete.
- [oauth-types.ts](oauth-types.ts): `TokenStore`, `OAuthTokens`, injected `fetch`, clock and sleep. Storage itself belongs to ATO-1120.

## Rules

- Errors carry only a code, an HTTP status and a sanitized OAuth `error` id. Tokens, authorization codes, verifiers, device codes and server `error_description` text never appear in messages, fields or pages.
- Network failures drop the underlying cause, because it can echo the request.
- `refresh()` shares one in-flight request; the first caller's abort signal applies to it.

## Open questions

- Whether a refused refresh should also clear the store automatically (today it does not; Codex keeps the file too).
- Codex refreshes with a JSON body; this uses the form body the primitives send, as opencode does. Untested against the live server.
- Copilot: Business and Enterprise accounts may be served from the host in the token answer's `endpoints.api`; this always uses `api.githubcopilot.com`. The model list is read at `/v1/models`, which Copilot may not serve (it lists models at `/models`). Both untested against the live service.
