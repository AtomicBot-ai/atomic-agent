import {
  OAuthFlowError,
  sanitizeOAuthError,
} from "./oauth-errors.js";
import type { Clock, FetchLike, OAuthTokens } from "./oauth-types.js";

export interface TokenRequest {
  fetch: FetchLike;
  url: string;
  params: Record<string, string>;
  now: Clock;
  signal?: AbortSignal;
}

/** Parsed outcome of a token endpoint call: tokens, or the OAuth error id. */
export type TokenResult =
  | { kind: "tokens"; tokens: OAuthTokens }
  | { kind: "error"; status: number; oauthError: string; body: unknown };

/** POSTs a form to a token-style endpoint and returns the parsed JSON body. */
export async function postForm(
  fetchImpl: FetchLike,
  url: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ status: number; ok: boolean; body: unknown }> {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(params).toString(),
      ...(signal ? { signal } : {}),
    });
  } catch {
    // The cause is dropped on purpose: it can echo the request.
    if (signal?.aborted) throw new OAuthFlowError("cancelled");
    throw new OAuthFlowError("network_error");
  }
  let body: unknown = null;
  try {
    const text = await response.text();
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, ok: response.ok, body };
}

/** Exchanges a grant at the token endpoint without throwing on OAuth errors. */
export async function requestToken(req: TokenRequest): Promise<TokenResult> {
  const { status, ok, body } = await postForm(
    req.fetch,
    req.url,
    req.params,
    req.signal,
  );
  if (!ok) {
    const error = isRecord(body) ? body.error : undefined;
    return { kind: "error", status, oauthError: sanitizeOAuthError(error), body };
  }
  return { kind: "tokens", tokens: parseTokens(body, req.now(), status) };
}

/** Same as requestToken, but any OAuth error becomes an OAuthFlowError. */
export async function requestTokenOrThrow(
  req: TokenRequest,
): Promise<OAuthTokens> {
  const result = await requestToken(req);
  if (result.kind === "error") {
    throw new OAuthFlowError("token_request_failed", {
      status: result.status,
      oauthError: result.oauthError,
    });
  }
  return result.tokens;
}

function parseTokens(body: unknown, now: number, status: number): OAuthTokens {
  if (!isRecord(body) || typeof body.access_token !== "string" || body.access_token === "") {
    throw new OAuthFlowError("invalid_token_response", { status });
  }
  const tokens: OAuthTokens = { accessToken: body.access_token };
  if (typeof body.refresh_token === "string" && body.refresh_token !== "") {
    tokens.refreshToken = body.refresh_token;
  }
  if (typeof body.id_token === "string") tokens.idToken = body.id_token;
  if (typeof body.token_type === "string") tokens.tokenType = body.token_type;
  if (typeof body.scope === "string") tokens.scope = body.scope;
  const expiresIn = Number(body.expires_in);
  if (body.expires_in !== undefined && Number.isFinite(expiresIn) && expiresIn >= 0) {
    tokens.expiresAt = now + expiresIn * 1000;
  }
  return tokens;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
