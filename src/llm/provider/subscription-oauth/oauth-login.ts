import { openLoopbackCallback } from "./loopback-callback.js";
import type { Clock, FetchLike, OAuthTokens } from "./oauth-types.js";
import { createOAuthState, createPkcePair } from "./pkce.js";
import { requestTokenOrThrow } from "./token-request.js";

/**
 * Everything provider specific is injected: this module has no built-in
 * client id, endpoint, scope or redirect path for any service.
 */
export interface BrowserLoginOptions {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scope?: string;
  /** Extra authorize parameters; cannot override the PKCE/state/redirect ones. */
  extraAuthorizeParams?: Record<string, string>;
  /** Extra token-exchange form fields. */
  extraTokenParams?: Record<string, string>;
  /** Fixed loopback port when the provider pins it; unset = random free port. */
  port?: number;
  callbackPath?: string;
  /** Host written into redirect_uri; the server always binds to 127.0.0.1. */
  redirectHostname?: "127.0.0.1" | "localhost";
  timeoutMs: number;
  signal?: AbortSignal;
  fetch: FetchLike;
  now?: Clock;
}

export interface BrowserLogin {
  /** Open this in the user's browser (the caller decides how). */
  authorizationUrl: string;
  redirectUri: string;
  /** Resolves with tokens after the redirect and code exchange. */
  tokens: Promise<OAuthTokens>;
  cancel(): void;
}

const DEFAULT_CALLBACK_PATH = "/callback";

/** Starts the loopback receiver and returns the PKCE authorization URL. */
export async function startBrowserLogin(
  options: BrowserLoginOptions,
): Promise<BrowserLogin> {
  const pkce = createPkcePair();
  const state = createOAuthState();
  const path = options.callbackPath ?? DEFAULT_CALLBACK_PATH;
  const host = options.redirectHostname ?? "127.0.0.1";
  const now = options.now ?? Date.now;
  let redirectUri = "";

  const callback = await openLoopbackCallback<OAuthTokens>({
    path,
    expectedState: state,
    timeoutMs: options.timeoutMs,
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    onCode: (code, signal) =>
      requestTokenOrThrow({
        fetch: options.fetch,
        url: options.tokenUrl,
        now,
        signal,
        params: {
          ...options.extraTokenParams,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: options.clientId,
          code_verifier: pkce.verifier,
        },
      }),
  });
  redirectUri = `http://${host}:${callback.port}${path}`;

  const url = new URL(options.authorizeUrl);
  for (const [key, value] of Object.entries(options.extraAuthorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", pkce.method);
  url.searchParams.set("state", state);
  if (options.scope !== undefined) url.searchParams.set("scope", options.scope);

  return {
    authorizationUrl: url.toString(),
    redirectUri,
    tokens: callback.result,
    cancel: callback.cancel,
  };
}
