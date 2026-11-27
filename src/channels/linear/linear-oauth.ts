/**
 * Installing Atomic Agent as a Linear app (ATO-2464): OAuth 2.0 with
 * `actor=app`, so the agent acts as its own workspace member and can be
 * mentioned and delegated to (Linear Agents API).
 *
 * The user creates an OAuth application in Linear (Settings, API, OAuth
 * applications) with the redirect URL `http://localhost:3980/linear/oauth/callback`;
 * `atag connect linear --app` opens the authorize page, catches the code
 * on that local address (127.0.0.1 only, checked against a random
 * `state`), and trades it for an access token. Linear app tokens can
 * expire; the refresh token and client secret are saved next to it so
 * the channel can renew it on its own (`linearTokenRefresher`).
 */

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { saveSecret } from "../../config/index.js";
import { LINEAR_API_KEY_KEY, resolveLinearSecret } from "./linear-types.js";

export const LINEAR_OAUTH_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
export const LINEAR_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
export const LINEAR_OAUTH_PORT = 3980;
export const LINEAR_OAUTH_PATH = "/linear/oauth/callback";
export const LINEAR_OAUTH_REDIRECT_URI = `http://localhost:${LINEAR_OAUTH_PORT}${LINEAR_OAUTH_PATH}`;
/** Agents API scopes: mentionable and assignable (delegation), plus read/write for comments. */
export const LINEAR_APP_SCOPES = "read,write,app:assignable,app:mentionable";
export const LINEAR_OAUTH_CLIENT_SECRET_KEY = "LINEAR_OAUTH_CLIENT_SECRET";
export const LINEAR_OAUTH_REFRESH_TOKEN_KEY = "LINEAR_OAUTH_REFRESH_TOKEN";

export function newOAuthState(): string {
  return randomBytes(16).toString("hex");
}

export function buildLinearAuthorizeUrl(clientId: string, state: string, redirectUri = LINEAR_OAUTH_REDIRECT_URI): string {
  const url = new URL(LINEAR_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", LINEAR_APP_SCOPES);
  url.searchParams.set("actor", "app");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export interface LinearTokens {
  accessToken: string;
  refreshToken?: string;
}

async function tokenRequest(form: Record<string, string>, fetchImpl: typeof fetch): Promise<LinearTokens> {
  const res = await fetchImpl(LINEAR_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  let json: { access_token?: unknown; refresh_token?: unknown; error?: unknown } | null = null;
  try {
    json = (await res.json()) as typeof json;
  } catch {
    json = null;
  }
  if (!res.ok || typeof json?.access_token !== "string") {
    const why = typeof json?.error === "string" ? json.error : `HTTP ${res.status}`;
    throw new Error(`Linear did not issue a token (${why})`);
  }
  return {
    accessToken: json.access_token,
    ...(typeof json.refresh_token === "string" ? { refreshToken: json.refresh_token } : {}),
  };
}

export function exchangeLinearCode(
  opts: { clientId: string; clientSecret: string; code: string; redirectUri?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<LinearTokens> {
  return tokenRequest(
    {
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.redirectUri ?? LINEAR_OAUTH_REDIRECT_URI,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
    },
    fetchImpl,
  );
}

export function refreshLinearToken(
  opts: { clientId: string; clientSecret: string; refreshToken: string },
  fetchImpl: typeof fetch = fetch,
): Promise<LinearTokens> {
  return tokenRequest(
    { grant_type: "refresh_token", refresh_token: opts.refreshToken, client_id: opts.clientId, client_secret: opts.clientSecret },
    fetchImpl,
  );
}

const DONE_PAGE =
  "<!doctype html><meta charset=utf-8><title>Atomic Agent</title><p style=\"font-family:system-ui\">Linear is connected. You can close this tab and go back to the terminal.</p>";

/**
 * Wait for Linear to redirect the browser back with `?code=...&state=...`.
 * Listens on 127.0.0.1 only; a wrong `state` is refused and ignored.
 */
export function waitForLinearOAuthCode(state: string, timeoutMs = 5 * 60_000, port = LINEAR_OAUTH_PORT): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== LINEAR_OAUTH_PATH) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      if (url.searchParams.get("state") !== state || !code) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end("This sign-in link is not the one Atomic Agent opened.");
        if (url.searchParams.get("error")) finish(new Error("Linear sign-in was cancelled"));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(DONE_PAGE);
      finish(null, code);
    });
    const timer = setTimeout(() => finish(new Error("Timed out waiting for Linear sign-in")), timeoutMs);
    timer.unref?.();
    function finish(err: Error | null, code?: string): void {
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve(code ?? "");
    }
    server.on("error", (err: NodeJS.ErrnoException) =>
      finish(err.code === "EADDRINUSE" ? new Error(`Port ${port} on this computer is busy; close what uses it and try again`) : err),
    );
    server.listen(port, "127.0.0.1");
  });
}

/**
 * The channel's token renewer for an app install: trades the saved
 * refresh token for a new access token and saves both. `null` when this
 * is not an app install (no client id, secret or refresh token), so a
 * refused personal key is reported as before.
 */
export function linearTokenRefresher(
  stateDir: string,
  clientId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): (() => Promise<string | null>) | null {
  const clientSecret = resolveLinearSecret(LINEAR_OAUTH_CLIENT_SECRET_KEY, undefined, env);
  if (!clientId || clientSecret === null || resolveLinearSecret(LINEAR_OAUTH_REFRESH_TOKEN_KEY, undefined, env) === null) {
    return null;
  }
  return async () => {
    const refreshToken = resolveLinearSecret(LINEAR_OAUTH_REFRESH_TOKEN_KEY, undefined, env);
    if (refreshToken === null) return null;
    const tokens = await refreshLinearToken({ clientId, clientSecret, refreshToken }, fetchImpl);
    saveSecret(stateDir, LINEAR_API_KEY_KEY, tokens.accessToken);
    env[LINEAR_API_KEY_KEY] = tokens.accessToken;
    if (tokens.refreshToken) {
      saveSecret(stateDir, LINEAR_OAUTH_REFRESH_TOKEN_KEY, tokens.refreshToken);
      env[LINEAR_OAUTH_REFRESH_TOKEN_KEY] = tokens.refreshToken;
    }
    return tokens.accessToken;
  };
}
