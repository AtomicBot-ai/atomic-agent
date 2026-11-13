import { OAuthFlowError, SignInRequiredError } from "./oauth-errors.js";
import type { Clock, FetchLike, OAuthTokens, TokenStore } from "./oauth-types.js";
import { requestToken } from "./token-request.js";

export interface TokenRefresherOptions {
  store: TokenStore;
  tokenUrl: string;
  clientId: string;
  fetch: FetchLike;
  /** Refresh this long before `expiresAt` (default 60 s). */
  skewMs?: number;
  extraParams?: Record<string, string>;
  now?: Clock;
}

export interface TokenRefresher {
  /** Stored tokens, refreshed first when they are expired or about to be. */
  getValidTokens(signal?: AbortSignal): Promise<OAuthTokens>;
  /** Forces a refresh (for example after a 401); shares an in-flight one. */
  refresh(signal?: AbortSignal): Promise<OAuthTokens>;
}

const DEFAULT_SKEW_MS = 60_000;
/** RFC 6749 section 5.2: the refresh token itself was refused. */
const REFUSED = new Set(["invalid_grant", "unauthorized_client", "invalid_client"]);

export function createTokenRefresher(options: TokenRefresherOptions): TokenRefresher {
  const now = options.now ?? Date.now;
  const skewMs = options.skewMs ?? DEFAULT_SKEW_MS;
  let inflight: Promise<OAuthTokens> | null = null;

  // The shared request never takes a caller's signal: one caller giving up
  // must not cancel the refresh that other callers joined.
  async function runRefresh(): Promise<OAuthTokens> {
    const current = await options.store.load();
    if (!current) throw new SignInRequiredError("no_tokens");
    if (!current.refreshToken) throw new SignInRequiredError("no_refresh_token");
    const result = await requestToken({
      fetch: options.fetch,
      url: options.tokenUrl,
      now,
      params: {
        ...options.extraParams,
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: options.clientId,
      },
    });
    if (result.kind === "error") {
      if (REFUSED.has(result.oauthError)) throw new SignInRequiredError("refresh_refused");
      throw new OAuthFlowError("token_request_failed", {
        status: result.status,
        oauthError: result.oauthError,
      });
    }
    // Servers that do not rotate refresh tokens omit it from the response.
    const next: OAuthTokens = {
      ...result.tokens,
      refreshToken: result.tokens.refreshToken ?? current.refreshToken,
    };
    if (next.idToken === undefined && current.idToken !== undefined) {
      next.idToken = current.idToken;
    }
    await options.store.save(next);
    return next;
  }

  function refresh(signal?: AbortSignal): Promise<OAuthTokens> {
    if (!inflight) {
      inflight = runRefresh().finally(() => {
        inflight = null;
      });
    }
    return withCallerSignal(inflight, signal);
  }

  async function getValidTokens(signal?: AbortSignal): Promise<OAuthTokens> {
    if (inflight) return withCallerSignal(inflight, signal);
    const tokens = await options.store.load();
    if (!tokens) throw new SignInRequiredError("no_tokens");
    if (tokens.expiresAt === undefined || now() + skewMs < tokens.expiresAt) {
      return tokens;
    }
    return refresh(signal);
  }

  return { getValidTokens, refresh };
}

/** Rejects this caller with `cancelled` on abort; the shared refresh keeps going. */
function withCallerSignal(shared: Promise<OAuthTokens>, signal?: AbortSignal): Promise<OAuthTokens> {
  if (!signal) return shared;
  if (signal.aborted) return Promise.reject(new OAuthFlowError("cancelled"));
  return new Promise<OAuthTokens>((resolve, reject) => {
    const onAbort = () => reject(new OAuthFlowError("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    shared.then(
      (tokens) => {
        signal.removeEventListener("abort", onAbort);
        resolve(tokens);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
