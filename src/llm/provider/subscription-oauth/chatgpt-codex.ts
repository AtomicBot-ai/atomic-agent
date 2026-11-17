import { OAuthFlowError, sanitizeOAuthError } from "./oauth-errors.js";
import type { Clock, FetchLike, OAuthTokens, Sleep, TokenStore } from "./oauth-types.js";
import { startBrowserLogin, type BrowserLogin } from "./oauth-login.js";
import { abortableSleep } from "./sleep.js";
import { createTokenRefresher, type TokenRefresher } from "./token-refresh.js";
import { isRecord, requestTokenOrThrow } from "./token-request.js";

/**
 * EXPERIMENTAL (ATO-1448): sign in with a ChatGPT plan the way the Codex
 * CLI does, without the Codex CLI installed.
 *
 * Every value below is copied from openai/codex (codex-rs) at commit
 * 6d94d4af1070d8c7230a1027a3a18753e0796c4e; the file each one comes
 * from is named next to it. OpenAI has not published this as a
 * third-party API, so any of them can change without notice; the
 * Codex CLI path (`subscription-cli`) stays the primary way to use a
 * ChatGPT plan.
 */

/** codex-rs/login/src/server.rs `DEFAULT_ISSUER`. */
export const CHATGPT_ISSUER = "https://auth.openai.com";
/** codex-rs/login/src/server.rs `build_authorize_url` (`{issuer}/oauth/authorize`). */
export const CHATGPT_AUTHORIZE_URL = `${CHATGPT_ISSUER}/oauth/authorize`;
/** codex-rs/login/src/auth/manager.rs `REFRESH_TOKEN_URL`; also the code-exchange endpoint. */
export const CHATGPT_TOKEN_URL = `${CHATGPT_ISSUER}/oauth/token`;
/** codex-rs/login/src/auth/manager.rs `CLIENT_ID`: the Codex CLI's public OAuth client. */
export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/**
 * codex-rs/login/src/server.rs `DEFAULT_PORT` / `FALLBACK_PORT`: the
 * only ports the client's redirect allow-list holds.
 */
export const CHATGPT_CALLBACK_PORT = 1455;
export const CHATGPT_FALLBACK_CALLBACK_PORT = 1457;
/** codex-rs/login/src/server.rs `run_login_server` redirect path. */
export const CHATGPT_CALLBACK_PATH = "/auth/callback";
/**
 * Scopes. Codex asks for `openid profile email offline_access` plus its
 * own connector scopes (`api.connectors.read api.connectors.invoke`),
 * which this agent has no use for; opencode's ChatGPT login asks for
 * the four standard ones only, and so does this.
 */
export const CHATGPT_SCOPE = "openid profile email offline_access";
/**
 * `originator` names the client to the backend (an authorize parameter
 * and a request header). Codex sends `codex_cli_rs`; pi and opencode
 * send their own names, so this sends ours rather than pretending to be
 * Codex.
 */
export const CHATGPT_ORIGINATOR = "atomic_agent";
/** codex-rs/model-provider-info/src/lib.rs `CHATGPT_CODEX_BASE_URL`. */
export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
/** codex-rs/http-client/src/openai_headers.rs `CHATGPT_ACCOUNT_ID_HEADER`. */
export const CHATGPT_ACCOUNT_ID_HEADER = "chatgpt-account-id";
/**
 * codex-rs/login/src/device_code_auth.rs: OpenAI's own device flow, not
 * RFC 8628 (JSON bodies, a `device_auth_id`, and an authorization code
 * plus PKCE verifier handed back instead of tokens).
 */
export const CHATGPT_DEVICE_USERCODE_URL = `${CHATGPT_ISSUER}/api/accounts/deviceauth/usercode`;
export const CHATGPT_DEVICE_TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/deviceauth/token`;
export const CHATGPT_DEVICE_VERIFICATION_URL = `${CHATGPT_ISSUER}/codex/device`;
export const CHATGPT_DEVICE_REDIRECT_URI = `${CHATGPT_ISSUER}/deviceauth/callback`;
/** The service name used for the token file (`auth/chatgpt.json`). */
export const CHATGPT_SERVICE = "chatgpt";

/** codex-rs/login/src/server.rs `build_authorize_url` extra parameters. */
const CHATGPT_AUTHORIZE_EXTRA = {
  id_token_add_organizations: "true",
  codex_cli_simplified_flow: "true",
  originator: CHATGPT_ORIGINATOR,
};

/** codex-rs/login/src/device_code_auth.rs `poll_for_token`: 15 minutes. */
const DEVICE_MAX_WAIT_MS = 15 * 60_000;
const DEVICE_DEFAULT_INTERVAL_MS = 5_000;

/**
 * The claims Codex reads (codex-rs/login/src/token_data.rs): the
 * account id lives under the `https://api.openai.com/auth` namespace.
 */
const AUTH_CLAIM = "https://api.openai.com/auth";

/** Decodes a JWT payload without verifying it; we only read our own token. */
export function decodeJwtPayload(jwt: string | undefined): Record<string, unknown> | null {
  if (typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * `chatgpt_account_id` from the id token (Codex's source), else from the
 * access token (opencode falls back to it the same way).
 */
export function chatgptAccountId(tokens: Pick<OAuthTokens, "idToken" | "accessToken">): string | null {
  for (const jwt of [tokens.idToken, tokens.accessToken]) {
    const auth = decodeJwtPayload(jwt)?.[AUTH_CLAIM];
    if (isRecord(auth) && typeof auth.chatgpt_account_id === "string" && auth.chatgpt_account_id.length > 0) {
      return auth.chatgpt_account_id;
    }
  }
  return null;
}

/** `chatgpt_plan_type` (plus, pro, team, ...), for status lines. */
export function chatgptPlanType(tokens: Pick<OAuthTokens, "idToken" | "accessToken">): string | null {
  for (const jwt of [tokens.idToken, tokens.accessToken]) {
    const auth = decodeJwtPayload(jwt)?.[AUTH_CLAIM];
    if (isRecord(auth) && typeof auth.chatgpt_plan_type === "string") return auth.chatgpt_plan_type;
  }
  return null;
}

/**
 * The token response does not always carry `expires_in`; the access
 * token's own `exp` then says when it runs out (Codex reads it the same
 * way, `parse_jwt_expiration`).
 */
export function withJwtExpiry(tokens: OAuthTokens): OAuthTokens {
  if (tokens.expiresAt !== undefined) return tokens;
  const exp = decodeJwtPayload(tokens.accessToken)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? { ...tokens, expiresAt: exp * 1000 } : tokens;
}

/** A store that fills `expiresAt` from the JWT on every save. */
export function chatgptTokenStore(store: TokenStore): TokenStore {
  return {
    load: () => store.load(),
    save: (tokens) => store.save(withJwtExpiry(tokens)),
    clear: () => store.clear(),
  };
}

/** The sign-in worked but the account has no ChatGPT workspace to bill. */
export class ChatgptNoAccountError extends Error {
  constructor() {
    super("Signed in, but the token names no ChatGPT account. A ChatGPT plan (Plus, Pro, Team, ...) is needed.");
    this.name = "ChatgptNoAccountError";
  }
}

function requireAccount(tokens: OAuthTokens): OAuthTokens {
  if (chatgptAccountId(tokens) === null) throw new ChatgptNoAccountError();
  return withJwtExpiry(tokens);
}

export interface ChatgptBrowserLoginOptions {
  fetch: FetchLike;
  timeoutMs: number;
  signal?: AbortSignal;
  now?: Clock;
  /** Test seam: the receiver's port; default 1455, then 1457 when busy. */
  ports?: readonly number[];
}

/**
 * Browser sign-in (PKCE). Binds 127.0.0.1 on 1455, or 1457 when 1455 is
 * taken, as Codex does; the redirect URI says `localhost`, as opencode
 * and pi do (Codex itself writes `127.0.0.1`; both are on the client's
 * allow-list).
 */
export async function startChatgptBrowserLogin(
  options: ChatgptBrowserLoginOptions,
): Promise<BrowserLogin> {
  const ports = options.ports ?? [CHATGPT_CALLBACK_PORT, CHATGPT_FALLBACK_CALLBACK_PORT];
  let lastError: unknown = new OAuthFlowError("callback_port_unavailable");
  for (const port of ports) {
    try {
      const login = await startBrowserLogin({
        authorizeUrl: CHATGPT_AUTHORIZE_URL,
        tokenUrl: CHATGPT_TOKEN_URL,
        clientId: CHATGPT_CLIENT_ID,
        scope: CHATGPT_SCOPE,
        extraAuthorizeParams: CHATGPT_AUTHORIZE_EXTRA,
        port,
        callbackPath: CHATGPT_CALLBACK_PATH,
        redirectHostname: "localhost",
        timeoutMs: options.timeoutMs,
        fetch: options.fetch,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
      return { ...login, tokens: login.tokens.then(requireAccount) };
    } catch (err) {
      lastError = err;
      if (!(err instanceof OAuthFlowError) || err.code !== "callback_port_unavailable") throw err;
    }
  }
  throw lastError;
}

/** What the person types, and where. `deviceAuthId` is opaque and never shown. */
export interface ChatgptDeviceCode {
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  intervalMs: number;
}

export interface ChatgptDeviceLoginOptions {
  fetch: JsonFetchLike;
  /** The form-encoded fetch the token exchange uses (the primitives' shape). */
  formFetch: FetchLike;
  signal?: AbortSignal;
  now?: Clock;
  sleep?: Sleep;
}

/** JSON POST, for OpenAI's device endpoints (they take JSON, not a form). */
export type JsonFetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

async function postJson(
  fetchImpl: JsonFetchLike,
  url: string,
  body: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ status: number; ok: boolean; body: unknown }> {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch {
    // Dropped on purpose, as in the primitives: the cause can echo the body.
    if (signal?.aborted) throw new OAuthFlowError("cancelled");
    throw new OAuthFlowError("network_error");
  }
  let parsed: unknown = null;
  try {
    const text = await response.text();
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, ok: response.ok, body: parsed };
}

/** Step 1 of the device flow (codex-rs/login/src/device_code_auth.rs `request_user_code`). */
export async function requestChatgptDeviceCode(
  options: Pick<ChatgptDeviceLoginOptions, "fetch" | "signal">,
): Promise<ChatgptDeviceCode> {
  const { status, ok, body } = await postJson(
    options.fetch,
    CHATGPT_DEVICE_USERCODE_URL,
    { client_id: CHATGPT_CLIENT_ID },
    options.signal,
  );
  if (!ok) {
    // 404: device sign-in is not enabled for this account or server.
    throw new OAuthFlowError("token_request_failed", {
      status,
      oauthError: status === 404 ? "device_login_not_enabled" : sanitizeOAuthError(isRecord(body) ? body.error : undefined),
    });
  }
  const userCode = isRecord(body) ? (body.user_code ?? body.usercode) : undefined;
  if (!isRecord(body) || typeof body.device_auth_id !== "string" || typeof userCode !== "string") {
    throw new OAuthFlowError("invalid_token_response", { status });
  }
  // Codex parses `interval` as a string of seconds; accept a number too.
  const seconds = Number.parseInt(String(body.interval ?? ""), 10);
  return {
    verificationUrl: CHATGPT_DEVICE_VERIFICATION_URL,
    userCode,
    deviceAuthId: body.device_auth_id,
    intervalMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEVICE_DEFAULT_INTERVAL_MS,
  };
}

/**
 * Step 2: poll until the person approves (403/404 mean "not yet", as in
 * Codex), then exchange the authorization code it hands back, with the
 * PKCE verifier it hands back, at the token endpoint.
 */
export async function completeChatgptDeviceLogin(
  options: ChatgptDeviceLoginOptions,
  code: ChatgptDeviceCode,
): Promise<OAuthTokens> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const deadline = now() + DEVICE_MAX_WAIT_MS;
  for (;;) {
    if (options.signal?.aborted) throw new OAuthFlowError("cancelled");
    const { status, ok, body } = await postJson(
      options.fetch,
      CHATGPT_DEVICE_TOKEN_URL,
      { device_auth_id: code.deviceAuthId, user_code: code.userCode },
      options.signal,
    );
    if (ok) {
      if (
        !isRecord(body) ||
        typeof body.authorization_code !== "string" ||
        typeof body.code_verifier !== "string"
      ) {
        throw new OAuthFlowError("invalid_token_response", { status });
      }
      const tokens = await requestTokenOrThrow({
        fetch: options.formFetch,
        url: CHATGPT_TOKEN_URL,
        now,
        ...(options.signal ? { signal: options.signal } : {}),
        params: {
          grant_type: "authorization_code",
          code: body.authorization_code,
          redirect_uri: CHATGPT_DEVICE_REDIRECT_URI,
          client_id: CHATGPT_CLIENT_ID,
          code_verifier: body.code_verifier,
        },
      });
      return requireAccount(tokens);
    }
    if (status !== 403 && status !== 404) {
      throw new OAuthFlowError("token_request_failed", {
        status,
        oauthError: sanitizeOAuthError(isRecord(body) ? body.error : undefined),
      });
    }
    const left = deadline - now();
    if (left <= 0) throw new OAuthFlowError("device_code_expired");
    await sleep(Math.min(code.intervalMs, left), options.signal);
  }
}

export interface ChatgptRefresherOptions {
  store: TokenStore;
  fetch: FetchLike;
  now?: Clock;
}

/**
 * Refresh through the primitives. Codex refreshes 401s and soon-to-expire
 * tokens the same way; the primitives' 60 s skew covers the second.
 */
export function createChatgptTokenRefresher(options: ChatgptRefresherOptions): TokenRefresher {
  return createTokenRefresher({
    store: chatgptTokenStore(options.store),
    tokenUrl: CHATGPT_TOKEN_URL,
    clientId: CHATGPT_CLIENT_ID,
    fetch: options.fetch,
    ...(options.now ? { now: options.now } : {}),
  });
}
