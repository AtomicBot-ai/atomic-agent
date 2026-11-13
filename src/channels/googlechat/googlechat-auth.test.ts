import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  GoogleAuthError,
  GoogleTokenSource,
  parseServiceAccountKey,
  signServiceAccountJwt,
} from "./googlechat-auth.js";
import { GOOGLE_CHAT_SCOPES, GOOGLE_TOKEN_URL } from "./googlechat-types.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const KEY = { clientEmail: "bot@proj.iam.gserviceaccount.com", privateKey, privateKeyId: "kid-1" };

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("parseServiceAccountKey", () => {
  it("reads client_email, private_key and private_key_id", () => {
    const parsed = parseServiceAccountKey(
      JSON.stringify({
        type: "service_account",
        client_email: KEY.clientEmail,
        private_key: privateKey,
        private_key_id: "kid-1",
        token_uri: "https://evil.example/token",
      }),
    );
    expect(parsed).toEqual(KEY);
  });

  it("names the missing field without echoing any contents", () => {
    const secret = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";
    expect(() => parseServiceAccountKey("not json " + secret)).toThrow(/not valid JSON/);
    try {
      parseServiceAccountKey(JSON.stringify({ private_key: secret }));
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/client_email/);
      expect((err as Error).message).not.toContain("AAAA");
    }
    expect(() =>
      parseServiceAccountKey(JSON.stringify({ type: "authorized_user", client_email: "a", private_key: secret })),
    ).toThrow(/service-account/);
  });
});

describe("signServiceAccountJwt", () => {
  it("builds an RS256 JWT bearer assertion Google verifies", () => {
    const jwt = signServiceAccountJwt(KEY, GOOGLE_CHAT_SCOPES, 1_700_000_000);
    const [h, c, sig] = jwt.split(".");
    expect(sig).toBeTruthy();
    expect(decodePart(h ?? "")).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-1" });
    expect(decodePart(c ?? "")).toEqual({
      iss: KEY.clientEmail,
      scope: "https://www.googleapis.com/auth/pubsub https://www.googleapis.com/auth/chat.bot",
      aud: GOOGLE_TOKEN_URL,
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${h}.${c}`);
    expect(verifier.verify(publicKey, Buffer.from(sig ?? "", "base64url"))).toBe(true);
  });
});

describe("GoogleTokenSource", () => {
  function tokenServer(responses: Response[]) {
    const bodies: string[] = [];
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      bodies.push(String(init?.body));
      return responses.shift() ?? new Response("{}", { status: 500 });
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, bodies, urls, calls: fetchImpl };
  }
  const ok = (token: string, expiresIn = 3600) =>
    new Response(JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: "Bearer" }), {
      status: 200,
    });

  it("exchanges the assertion at the fixed endpoint and caches until near expiry", async () => {
    let now = 1_700_000_000_000;
    const server = tokenServer([ok("ya29.first"), ok("ya29.second")]);
    const source = new GoogleTokenSource({
      key: KEY,
      scopes: GOOGLE_CHAT_SCOPES,
      fetchImpl: server.fetchImpl,
      now: () => now,
    });
    expect(await source.token()).toBe("ya29.first");
    expect(server.urls).toEqual([GOOGLE_TOKEN_URL]);
    const form = new URLSearchParams(server.bodies[0]);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(form.get("assertion")?.split(".")).toHaveLength(3);

    now += 30 * 60_000;
    expect(await source.token()).toBe("ya29.first");
    expect(server.calls).toHaveBeenCalledTimes(1);

    now += 30 * 60_000; // past expiry minus the margin
    expect(await source.token()).toBe("ya29.second");
    expect(server.calls).toHaveBeenCalledTimes(2);
  });

  it("shares one exchange between concurrent callers and refreshes after invalidate()", async () => {
    const server = tokenServer([ok("ya29.a"), ok("ya29.b")]);
    const source = new GoogleTokenSource({ key: KEY, scopes: GOOGLE_CHAT_SCOPES, fetchImpl: server.fetchImpl });
    const [a, b] = await Promise.all([source.token(), source.token()]);
    expect([a, b]).toEqual(["ya29.a", "ya29.a"]);
    source.invalidate();
    expect(await source.token()).toBe("ya29.b");
    expect(server.calls).toHaveBeenCalledTimes(2);
  });

  it("reports a rejected key as a fatal GoogleAuthError without the assertion", async () => {
    const server = tokenServer([
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT Signature." }), {
        status: 400,
      }),
    ]);
    const source = new GoogleTokenSource({ key: KEY, scopes: GOOGLE_CHAT_SCOPES, fetchImpl: server.fetchImpl });
    const err = (await source.token().catch((e: unknown) => e)) as GoogleAuthError;
    expect(err).toBeInstanceOf(GoogleAuthError);
    expect(err.fatal).toBe(true);
    expect(err.message).toContain("invalid_grant");
    expect(err.message).not.toContain("eyJ");
  });
});
