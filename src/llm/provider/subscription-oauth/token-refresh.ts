import { OAuthFlowError, SignInRequiredError } from "./oauth-errors.js";
import type { Clock, FetchLike, OAuthTokens, TokenStore } from "./oauth-types.js";
import { requestToken, type TokenEncoding } from "./token-request.js";

export interface TokenRefresherOptions {
  store: TokenStore;
  tokenUrl: string;
  clientId: string;
  fetch: FetchLike;
  /** Refresh this long before `expiresAt` (default 60 s). */
  skewMs?: number;
  extraParams?: Record<string, string>;
  /** Body encoding of the refresh request (default `form`). */
  encoding?: TokenEncoding;
  /** Extra headers on the refresh request. */
  headers?: Record<string, string>;
  /**
   * Send why the refresh happens as `refresh_reason`, the way Codex does
   * (`proactive_expiry` before expiry, `unauthorized_recovery` after a
   * 401; codex-rs/login/src/oauth/client.rs `RefreshReason`).
   */
  sendRefreshReason?: boolean;
  now?: Clock;
}

export type RefreshReason = "proactive_expiry" | "unauthorized_recovery";

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
  async function runRefresh(reason: RefreshReason): Promise<OAuthTokens> {
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
        ...(options.sendRefreshReason ? { refresh_reason: reason } : {}),
      },
      ...(options.encoding ? { encoding: options.encoding } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
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

  function startRefresh(reason: RefreshReason, signal?: AbortSignal): Promise<OAuthTokens> {
    if (!inflight) {
      inflight = runRefresh(reason).finally(() => {
        inflight = null;
      });
    }
    return withCallerSignal(inflight, signal);
  }

  function refresh(signal?: AbortSignal): Promise<OAuthTokens> {
    return startRefresh("unauthorized_recovery", signal);
  }

  async function getValidTokens(signal?: AbortSignal): Promise<OAuthTokens> {
    if (inflight) return withCallerSignal(inflight, signal);
    const tokens = await options.store.load();
    if (!tokens) throw new SignInRequiredError("no_tokens");
    if (tokens.expiresAt === undefined || now() + skewMs < tokens.expiresAt) {
      return tokens;
    }
    return startRefresh("proactive_expiry", signal);
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
