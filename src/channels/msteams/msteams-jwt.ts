/**
 * Bot Framework request authentication for the Teams channel (ATO-506).
 *
 * The inbound endpoint is reachable from the internet through the
 * user's tunnel, so a request is trusted only when its
 * `Authorization: Bearer <jwt>` checks out the way the Bot Framework
 * "authenticate requests from the Bot Connector" rules require:
 *
 * - RS256, signed by a key from the Bot Framework OpenID metadata
 *   (`jwks_uri`), keys cached and refreshed on an unknown `kid`;
 * - the key's `endorsements` (when present) include the activity's
 *   `channelId`;
 * - `iss` is `https://api.botframework.com`, `aud` is our App ID;
 * - `exp` / `nbf` hold with five minutes of clock skew;
 * - the `serviceurl` claim equals the activity's `serviceUrl`, so a
 *   valid token cannot steer our replies (and our bearer token) to a
 *   host of the caller's choosing.
 *
 * Everything else is refused with `TeamsAuthError`, which the server
 * turns into a 401.
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

import type { TeamsActivity } from "./msteams-types.js";

export const BOT_FRAMEWORK_OPENID_URL =
  "https://login.botframework.com/v1/.well-known/openidconfiguration";
export const BOT_FRAMEWORK_ISSUER = "https://api.botframework.com";

const CLOCK_SKEW_S = 5 * 60;
/** Keys rotate rarely; Microsoft asks for at least a daily refresh. */
const KEYS_TTL_MS = 24 * 60 * 60_000;
/** An unknown `kid` refetches at most this often, so junk tokens cannot hammer the metadata host. */
const MIN_REFRESH_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

/** One signing key as served by `jwks_uri`. */
export interface BotFrameworkJwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  /** Channel ids this key may sign for (`msteams`, `webchat`, ...). */
  endorsements?: string[];
}

export class TeamsAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamsAuthError";
  }
}

export interface TeamsJwtVerifierDeps {
  appId: string;
  fetchImpl?: typeof fetch;
  openIdUrl?: string;
  /** Milliseconds since the epoch; test seam. */
  now?: () => number;
}

export class TeamsJwtVerifier {
  private keys: BotFrameworkJwk[] | null = null;
  private fetchedAt = 0;
  private refreshing: Promise<BotFrameworkJwk[]> | null = null;

  constructor(private readonly deps: TeamsJwtVerifierDeps) {}

  /** Resolve when `authorization` authenticates `activity`; throw `TeamsAuthError` otherwise. */
  async verify(authorization: string | undefined, activity: TeamsActivity): Promise<void> {
    const match = /^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(
      authorization?.trim() ?? "",
    );
    if (!match) throw new TeamsAuthError("missing or malformed bearer token");
    const [, rawHeader = "", rawPayload = "", rawSignature = ""] = match;
    const header = decodeJson(rawHeader);
    const claims = decodeJson(rawPayload);
    const kid = header.kid;
    if (header.alg !== "RS256") throw new TeamsAuthError("unexpected token algorithm");
    if (typeof kid !== "string") throw new TeamsAuthError("token has no key id");

    const jwk = await this.keyFor(kid);
    if (!jwk || jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") {
      throw new TeamsAuthError("token signed by an unknown key");
    }
    let valid = false;
    try {
      const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
      valid = cryptoVerify(
        "RSA-SHA256",
        Buffer.from(`${rawHeader}.${rawPayload}`),
        key,
        Buffer.from(rawSignature, "base64url"),
      );
    } catch {
      valid = false;
    }
    if (!valid) throw new TeamsAuthError("bad token signature");

    if (Array.isArray(jwk.endorsements)) {
      if (typeof activity.channelId !== "string" || !jwk.endorsements.includes(activity.channelId)) {
        throw new TeamsAuthError("signing key is not endorsed for this channel");
      }
    }
    if (claims.iss !== BOT_FRAMEWORK_ISSUER) throw new TeamsAuthError("wrong token issuer");
    const aud = claims.aud;
    const audOk = Array.isArray(aud) ? aud.includes(this.deps.appId) : aud === this.deps.appId;
    if (!audOk) throw new TeamsAuthError("token is for another app");
    const nowS = Math.floor((this.deps.now ?? Date.now)() / 1000);
    const exp = claims.exp;
    const nbf = claims.nbf;
    if (typeof exp !== "number" || nowS > exp + CLOCK_SKEW_S) {
      throw new TeamsAuthError("token expired");
    }
    if (typeof nbf === "number" && nowS < nbf - CLOCK_SKEW_S) {
      throw new TeamsAuthError("token not yet valid");
    }
    const claimed = claims.serviceurl ?? claims.serviceUrl;
    if (
      typeof claimed !== "string" ||
      typeof activity.serviceUrl !== "string" ||
      normalizeServiceUrl(claimed) !== normalizeServiceUrl(activity.serviceUrl)
    ) {
      throw new TeamsAuthError("serviceUrl does not match the token");
    }
  }

  private async keyFor(kid: string): Promise<BotFrameworkJwk | undefined> {
    const now = (this.deps.now ?? Date.now)();
    if (this.keys === null || now - this.fetchedAt > KEYS_TTL_MS) {
      await this.refresh();
    }
    let found = this.keys?.find((k) => k.kid === kid);
    if (!found && now - this.fetchedAt > MIN_REFRESH_MS) {
      await this.refresh();
      found = this.keys?.find((k) => k.kid === kid);
    }
    return found;
  }

  private async refresh(): Promise<void> {
    this.refreshing ??= this.fetchKeys().finally(() => {
      this.refreshing = null;
    });
    try {
      this.keys = await this.refreshing;
      this.fetchedAt = (this.deps.now ?? Date.now)();
    } catch (err) {
      // Keep serving the old keys through a metadata outage.
      if (this.keys === null) {
        throw new TeamsAuthError(
          `could not load Bot Framework signing keys: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async fetchKeys(): Promise<BotFrameworkJwk[]> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    const meta = await getJson(doFetch, this.deps.openIdUrl ?? BOT_FRAMEWORK_OPENID_URL);
    const jwksUri = meta.jwks_uri;
    if (typeof jwksUri !== "string" || !isBotFrameworkHost(jwksUri)) {
      throw new Error("OpenID metadata has no Bot Framework jwks_uri");
    }
    const body = await getJson(doFetch, jwksUri);
    if (!Array.isArray(body.keys)) throw new Error("jwks_uri returned no keys");
    return body.keys as BotFrameworkJwk[];
  }
}

/** Lower-case host, no trailing slash: Bot Framework is not consistent about either. */
export function normalizeServiceUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.replace(/\/+$/, "");
  }
}

function isBotFrameworkHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "login.botframework.com" || u.hostname.endsWith(".botframework.com"));
  } catch {
    return false;
  }
}

async function getJson(doFetch: typeof fetch, url: string): Promise<Record<string, unknown>> {
  const res = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  const body = (await res.json()) as unknown;
  if (body === null || typeof body !== "object") throw new Error("not a JSON object");
  return body as Record<string, unknown>;
}

function decodeJson(part: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new TeamsAuthError("token is not valid JSON");
}
