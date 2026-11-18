import type { ApiKeySource } from "../openai/api-key-command.js";
import {
  pollDeviceToken,
  requestDeviceAuthorization,
  type DeviceAuthorization,
} from "./device-code.js";
import type { Clock, FetchLike, OAuthTokens, Sleep, TokenStore } from "./oauth-types.js";
import { isRecord } from "./token-request.js";

/**
 * EXPERIMENTAL (ATO-462): sign in with a GitHub Copilot plan.
 *
 * Nadya's decision (18.11.2026): Copilot only, on the ATO-1448 sign-in
 * framework; not Claude, not Grok. The flow is the one every agent that
 * offers Copilot uses (pi `packages/ai/src/auth/oauth/github-copilot.ts`,
 * OpenClaw `extensions/github-copilot`, Hermes `copilot_auth.py`,
 * opencode): approach studied, code written here.
 *
 *  1. GitHub's device flow (RFC 8628) with the Copilot editor's OAuth
 *     app id, scope `read:user`. Gives a long-lived GitHub token, kept in
 *     `<stateDir>/auth/copilot.json` (0600), never in config.json.
 *  2. Before requests, that token is exchanged at
 *     `api.github.com/copilot_internal/v2/token` for a Copilot token that
 *     lives about 30 minutes; it is cached in memory only and fetched
 *     again shortly before it expires or after a 401.
 *  3. Chat goes to Copilot's OpenAI-compatible
 *     `api.githubcopilot.com/chat/completions` with that token as Bearer
 *     and the editor headers Copilot requires.
 *
 * Experimental like the ChatGPT sign-in: GitHub can change the internal
 * token endpoint or the headers it accepts without notice.
 */

export const COPILOT_SERVICE = "copilot";

/**
 * The GitHub OAuth app the Copilot editor extensions sign in with; the
 * same id pi, OpenClaw, Hermes and opencode use. GitHub issues Copilot
 * tokens only to sign-ins through a Copilot-enabled app.
 */
export const COPILOT_GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const COPILOT_GITHUB_SCOPE = "read:user";
export const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
/** Copilot's chat API; `/chat/completions` directly under it, no `/v1`. */
export const COPILOT_API_BASE_URL = "https://api.githubcopilot.com";
/** A model every Copilot plan includes; the entry's `defaultChatModel` wins. */
export const COPILOT_DEFAULT_MODEL = "gpt-4.1";

/** Headers Copilot refuses requests without (the values the editor sends). */
export const COPILOT_EDITOR_HEADERS: Readonly<Record<string, string>> = {
  "editor-version": "vscode/1.99.3",
  "editor-plugin-version": "copilot-chat/0.26.7",
  "copilot-integration-id": "vscode-chat",
  "user-agent": "GitHubCopilotChat/0.26.7",
};

/** Refetch the Copilot token this long before it expires. */
const COPILOT_TOKEN_SKEW_MS = 60_000;

/**
 * GitHub's token endpoint answers a pending device grant with HTTP 200
 * and `{"error":"authorization_pending"}`, not the 400 RFC 8628 asks
 * for. The shared poller reads a 200 as tokens, so such an answer is
 * passed on as a 400 here; a real token answer is untouched.
 */
export function githubDeviceFetch(fetch: FetchLike): FetchLike {
  return async (url, init) => {
    const response = await fetch(url, init);
    if (!response.ok) return response;
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const isError = isRecord(body) && typeof body.error === "string" && typeof body.access_token !== "string";
    return { status: isError ? 400 : response.status, ok: !isError, text: async () => text };
  };
}

export interface CopilotDeviceLoginOptions {
  fetch: FetchLike;
  signal?: AbortSignal;
  now?: Clock;
  sleep?: Sleep;
}

function deviceOptions(options: CopilotDeviceLoginOptions) {
  return {
    deviceAuthorizationUrl: GITHUB_DEVICE_CODE_URL,
    tokenUrl: GITHUB_ACCESS_TOKEN_URL,
    clientId: COPILOT_GITHUB_CLIENT_ID,
    scope: COPILOT_GITHUB_SCOPE,
    fetch: githubDeviceFetch(options.fetch),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  };
}

/** Step 1a: the code to enter at github.com/login/device. */
export function requestCopilotDeviceCode(options: CopilotDeviceLoginOptions): Promise<DeviceAuthorization> {
  return requestDeviceAuthorization(deviceOptions(options));
}

/** Step 1b: waits for approval; resolves the GitHub token to store. */
export function completeCopilotDeviceLogin(
  options: CopilotDeviceLoginOptions,
  authorization: DeviceAuthorization,
): Promise<OAuthTokens> {
  return pollDeviceToken(deviceOptions(options), authorization);
}

/** The stored GitHub sign-in is missing or GitHub no longer accepts it. */
export class CopilotSignInRequiredError extends Error {
  readonly reason: "no_tokens" | "refused";

  constructor(reason: "no_tokens" | "refused") {
    super(
      reason === "no_tokens"
        ? "Not signed in to GitHub Copilot (experimental). Run `atag login copilot`."
        : "Sign in again: GitHub no longer accepts the Copilot sign-in (experimental). Run `atag login copilot`.",
    );
    this.name = "CopilotSignInRequiredError";
    this.reason = reason;
  }
}

/** Signed in, but GitHub gives this account no Copilot token. */
export class CopilotNotAvailableError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(
      `This GitHub account has no Copilot access for other apps (GitHub answered ${status}). Check that Copilot is active on the account, then run \`atag login copilot\` again.`,
    );
    this.name = "CopilotNotAvailableError";
    this.status = status;
  }
}

/** A GET with headers; `globalThis.fetch` in tests' narrower shape. */
export type CopilotGetFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export interface CopilotToken {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** Parses the token endpoint's answer: `token` and `expires_at` (epoch seconds). */
export function parseCopilotToken(body: unknown, now: number): CopilotToken | null {
  if (!isRecord(body) || typeof body.token !== "string" || body.token.length === 0) return null;
  const expiresAtSec = Number(body.expires_at);
  const refreshInSec = Number(body.refresh_in);
  const expiresAt = Number.isFinite(expiresAtSec) && expiresAtSec > 0
    ? expiresAtSec * 1000
    : now + (Number.isFinite(refreshInSec) && refreshInSec > 0 ? refreshInSec : 25 * 60) * 1000;
  return { token: body.token, expiresAt };
}

export interface CopilotTokenSourceOptions {
  /** Holds the GitHub token from step 1. */
  store: TokenStore;
  fetch: CopilotGetFetch;
  now?: Clock;
}

/**
 * Step 2 as the `ApiKeySource` the OpenAI-compatible provider already
 * takes (it replaces the key on every request and calls `invalidate`
 * after a 401, then retries once). The Copilot token is held in memory
 * only; concurrent requests share one exchange. Errors never carry a
 * token or the server's text.
 */
export function createCopilotTokenSource(options: CopilotTokenSourceOptions): ApiKeySource {
  const now = options.now ?? Date.now;
  let cached: CopilotToken | null = null;
  let pending: Promise<string> | null = null;

  const exchange = async (): Promise<string> => {
    const stored = await options.store.load();
    if (!stored || stored.accessToken.length === 0) throw new CopilotSignInRequiredError("no_tokens");
    let response;
    try {
      response = await options.fetch(COPILOT_TOKEN_URL, {
        method: "GET",
        headers: { ...COPILOT_EDITOR_HEADERS, authorization: `token ${stored.accessToken}`, accept: "application/json" },
      });
    } catch {
      // The cause is dropped on purpose: it can echo the request.
      throw new Error("Cannot reach api.github.com to renew the Copilot sign-in. Check the connection and try again.");
    }
    if (response.status === 401) throw new CopilotSignInRequiredError("refused");
    if (response.status === 403 || response.status === 404) throw new CopilotNotAvailableError(response.status);
    if (!response.ok) {
      throw new Error(`GitHub could not renew the Copilot sign-in (HTTP ${response.status}). Try again in a moment.`);
    }
    let body: unknown = null;
    try {
      body = JSON.parse(await response.text());
    } catch {
      body = null;
    }
    const parsed = parseCopilotToken(body, now());
    if (!parsed) throw new Error("GitHub answered the Copilot sign-in renewal without a token.");
    cached = parsed;
    return parsed.token;
  };

  return {
    async get() {
      if (cached && cached.expiresAt - COPILOT_TOKEN_SKEW_MS > now()) return cached.token;
      if (!pending) {
        pending = exchange().finally(() => {
          pending = null;
        });
      }
      return pending;
    },
    invalidate() {
      cached = null;
    },
  };
}

/** One source per token file, so a provider rebuilt on every model switch keeps one cached token. */
const sharedSources = new Map<string, ApiKeySource>();

export function sharedCopilotTokenSource(
  path: string,
  create: () => ApiKeySource,
): ApiKeySource {
  let source = sharedSources.get(path);
  if (!source) {
    source = create();
    sharedSources.set(path, source);
  }
  return source;
}

/** Test seam. */
export function resetCopilotTokenSources(): void {
  sharedSources.clear();
}
