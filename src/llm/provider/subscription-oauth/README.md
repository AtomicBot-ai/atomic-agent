# Subscription OAuth primitives

Status: unwired; pending ATO-1120 (secure token store) and the product decision on which subscription endpoints to use
Owner: src/llm/provider/subscription-oauth/

Generic OAuth 2.0 building blocks for signing in with a subscription account (ATO-1451). Nothing here is connected to a provider, config, CLI command or UI. There is no built-in client id, endpoint, scope, redirect path or port for any service: the caller passes all of them. Only Node built-ins are used (`node:http`, `node:crypto`).

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

## Open questions before wiring

- Which endpoints, client id, redirect port and path to use (Nadya's decision); some providers pin the port and need `localhost` in the redirect URI, see `redirectHostname`.
- Whether a refused refresh should also clear the store automatically (today it does not).
- How the provider request layer (ATO-1453) reacts to `SignInRequiredError`.
