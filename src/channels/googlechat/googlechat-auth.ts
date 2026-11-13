/**
 * Service-account auth for Google Chat and Pub/Sub, with `node:crypto`
 * only (the OAuth 2.0 JWT bearer flow, RFC 7523):
 *
 * 1. sign `{ iss, scope, aud, iat, exp }` with the key's RSA private key
 *    (RS256);
 * 2. `POST https://oauth2.googleapis.com/token` with
 *    `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`;
 * 3. cache the access token until shortly before `expires_in`.
 *
 * The token endpoint is fixed: a key file's own `token_uri` is ignored,
 * so a tampered file cannot send a signed assertion somewhere else.
 * Nothing here logs or rethrows the key file's contents.
 */

import { createSign } from "node:crypto";

import { GOOGLE_TOKEN_URL, scrubGoogleChatError } from "./googlechat-types.js";

export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
  privateKeyId?: string;
}

/** Lifetime asked for in the assertion; Google's maximum. */
const ASSERTION_LIFETIME_S = 3600;
/** Refresh this long before the token's stated expiry. */
const EXPIRY_MARGIN_MS = 60_000;

export class GoogleAuthError extends Error {
  /** A rejection that retrying cannot fix (bad key, revoked account). */
  readonly fatal: boolean;
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GoogleAuthError";
    this.fatal = status === 400 || status === 401 || status === 403;
  }
}

/**
 * Parse a service-account JSON key. Errors name the missing field only,
 * never a value: the text ends up in `lastError`.
 */
export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The Google Chat credentials file is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The Google Chat credentials file is not a JSON object.");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== undefined && obj.type !== "service_account") {
    throw new Error('The Google Chat credentials file is not a service-account key (type must be "service_account").');
  }
  const clientEmail = obj.client_email;
  const privateKey = obj.private_key;
  if (typeof clientEmail !== "string" || clientEmail.trim().length === 0) {
    throw new Error("The Google Chat credentials file has no client_email.");
  }
  if (typeof privateKey !== "string" || !privateKey.includes("PRIVATE KEY")) {
    throw new Error("The Google Chat credentials file has no private_key.");
  }
  return {
    clientEmail: clientEmail.trim(),
    privateKey,
    ...(typeof obj.private_key_id === "string" ? { privateKeyId: obj.private_key_id } : {}),
  };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** Build and RS256-sign the JWT bearer assertion. `nowSec` is Unix seconds. */
export function signServiceAccountJwt(
  key: ServiceAccountKey,
  scopes: readonly string[],
  nowSec: number,
): string {
  const header = {
    alg: "RS256",
    typ: "JWT",
    ...(key.privateKeyId ? { kid: key.privateKeyId } : {}),
  };
  const claims = {
    iss: key.clientEmail,
    scope: scopes.join(" "),
    aud: GOOGLE_TOKEN_URL,
    iat: nowSec,
    exp: nowSec + ASSERTION_LIFETIME_S,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(key.privateKey).toString("base64url")}`;
}

export interface GoogleTokenSourceDeps {
  key: ServiceAccountKey;
  scopes: readonly string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/** Hands out a cached access token, minting a new one when it nears expiry. */
export class GoogleTokenSource {
  private cached: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(private readonly deps: GoogleTokenSourceDeps) {}

  async token(): Promise<string> {
    const now = (this.deps.now ?? Date.now)();
    if (this.cached && now < this.cached.expiresAt) return this.cached.token;
    // Concurrent callers share one exchange.
    this.inflight ??= this.mint().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Forget the cached token (the API answered 401 with it). */
  invalidate(): void {
    this.cached = null;
  }

  private async mint(): Promise<string> {
    const now = (this.deps.now ?? Date.now)();
    let assertion: string;
    try {
      assertion = signServiceAccountJwt(this.deps.key, this.deps.scopes, Math.floor(now / 1000));
    } catch {
      throw new GoogleAuthError("Could not sign with the Google Chat service-account key.", 400);
    }
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
    let res: Response;
    try {
      res = await (this.deps.fetchImpl ?? fetch)(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new GoogleAuthError(`Google token request failed: ${scrubGoogleChatError(err, [assertion])}`, 0);
    }
    let parsed: Record<string, unknown> | undefined;
    try {
      const value: unknown = await res.json();
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const code = typeof parsed?.error === "string" ? ` ${parsed.error}` : "";
      const detail = typeof parsed?.error_description === "string" ? `: ${parsed.error_description}` : "";
      throw new GoogleAuthError(
        scrubGoogleChatError(`Google token request failed with HTTP ${res.status}${code}${detail}`, [assertion]),
        res.status,
      );
    }
    const token = parsed?.access_token;
    if (typeof token !== "string" || token.length === 0) {
      throw new GoogleAuthError("Google token response had no access_token.", 502);
    }
    const expiresIn = typeof parsed?.expires_in === "number" ? parsed.expires_in : 3600;
    const issuedAt = (this.deps.now ?? Date.now)();
    this.cached = {
      token,
      expiresAt: issuedAt + Math.max(0, expiresIn * 1000 - EXPIRY_MARGIN_MS),
    };
    return token;
  }
}
