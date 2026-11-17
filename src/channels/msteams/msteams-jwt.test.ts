import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { BOT_FRAMEWORK_ISSUER, TeamsAuthError, TeamsJwtVerifier, normalizeServiceUrl } from "./msteams-jwt.js";
import type { TeamsActivity } from "./msteams-types.js";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const SERVICE_URL = "https://smba.trafficmanager.net/emea/";
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

const good = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwkOf(key: KeyObject, kid: string, endorsements?: string[]) {
  const { n, e } = key.export({ format: "jwk" }) as { n: string; e: string };
  return { kty: "RSA", use: "sig", kid, n, e, ...(endorsements ? { endorsements } : {}) };
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(claims: Record<string, unknown> = {}, opts: { key?: KeyObject; kid?: string; alg?: string } = {}): string {
  const header = b64({ alg: opts.alg ?? "RS256", typ: "JWT", kid: opts.kid ?? "k1" });
  const payload = b64({
    iss: BOT_FRAMEWORK_ISSUER,
    aud: APP_ID,
    exp: NOW_S + 3600,
    nbf: NOW_S - 60,
    serviceurl: SERVICE_URL,
    ...claims,
  });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), opts.key ?? good.privateKey).toString("base64url");
  return `Bearer ${header}.${payload}.${signature}`;
}

function fakeFetch(keys: unknown[] = [jwkOf(good.publicKey, "k1", ["msteams"])]) {
  return vi.fn(async (url: string) => {
    if (String(url).includes("openidconfiguration")) {
      return new Response(JSON.stringify({ jwks_uri: "https://login.botframework.com/v1/.well-known/keys" }));
    }
    return new Response(JSON.stringify({ keys }));
  });
}

function verifier(fetchImpl = fakeFetch()) {
  return new TeamsJwtVerifier({ appId: APP_ID, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW_MS });
}

const activity: TeamsActivity = { type: "message", channelId: "msteams", serviceUrl: SERVICE_URL };

describe("TeamsJwtVerifier", () => {
  it("accepts a token signed by a Bot Framework key for our app", async () => {
    await expect(verifier().verify(token(), activity)).resolves.toBeUndefined();
  });

  it("rejects a token signed by another key", async () => {
    await expect(verifier().verify(token({}, { key: other.privateKey }), activity)).rejects.toBeInstanceOf(TeamsAuthError);
  });

  it("rejects a token for another app", async () => {
    await expect(verifier().verify(token({ aud: "someone-else" }), activity)).rejects.toThrow(/another app/);
  });

  it("rejects a token from another issuer", async () => {
    await expect(verifier().verify(token({ iss: "https://sts.windows.net/x/" }), activity)).rejects.toThrow(/issuer/);
  });

  it("rejects an expired token beyond the 5 minute skew, accepts within it", async () => {
    await expect(verifier().verify(token({ exp: NOW_S - 301 }), activity)).rejects.toThrow(/expired/);
    await expect(verifier().verify(token({ exp: NOW_S - 200 }), activity)).resolves.toBeUndefined();
  });

  it("rejects a token that is not valid yet", async () => {
    await expect(verifier().verify(token({ nbf: NOW_S + 600 }), activity)).rejects.toThrow(/not yet valid/);
  });

  it("rejects when the serviceUrl does not match the token claim", async () => {
    await expect(
      verifier().verify(token(), { ...activity, serviceUrl: "https://evil.example/" }),
    ).rejects.toThrow(/serviceUrl/);
  });

  it("ignores a trailing slash and host case when matching serviceUrl", () => {
    expect(normalizeServiceUrl("https://SMBA.trafficmanager.net/emea/")).toBe(normalizeServiceUrl("https://smba.trafficmanager.net/emea"));
  });

  it("rejects a key that is not endorsed for the activity's channel", async () => {
    await expect(verifier().verify(token(), { ...activity, channelId: "webchat" })).rejects.toThrow(/endorsed/);
  });

  it("rejects a missing or malformed bearer and a non-RS256 header", async () => {
    const v = verifier();
    await expect(v.verify(undefined, activity)).rejects.toBeInstanceOf(TeamsAuthError);
    await expect(v.verify("Basic abc", activity)).rejects.toBeInstanceOf(TeamsAuthError);
    await expect(v.verify(token({}, { alg: "HS256" }), activity)).rejects.toThrow(/algorithm/);
  });

  it("caches keys between requests", async () => {
    const f = fakeFetch();
    const v = verifier(f);
    await v.verify(token(), activity);
    await v.verify(token(), activity);
    expect(f).toHaveBeenCalledTimes(2); // metadata + keys, once
  });

  it("refuses to load keys from a jwks_uri outside botframework.com", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ jwks_uri: "https://evil.example/keys" })));
    await expect(verifier(f).verify(token(), activity)).rejects.toThrow(/signing keys/);
  });
});
