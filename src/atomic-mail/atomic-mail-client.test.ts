import { describe, expect, it, vi } from "vitest";

import { AtomicMailClient, decodeJwtPayload, solveProofOfWork } from "./atomic-mail-client.js";

function jwt(payload: Record<string, unknown>): string {
  const b64 = (s: string): string => Buffer.from(s).toString("base64url");
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`;
}

const inAnHour = Math.floor(Date.now() / 1000) + 3600;

/** A fake auth + JMAP origin that records every request. */
function fakeAtomicMail(opts: { apiKeyOnSignup?: string } = {}) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, method: init?.method ?? "GET", headers, body });
    const json = (data: unknown, extra: Record<string, string> = {}): Response =>
      new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json", ...extra } });
    if (u.endsWith("/api/v1/challenge")) {
      return json({}, { authorization: `Bearer ${jwt({ jti: "chal-1", difficulty: 1, exp: inAnHour })}` });
    }
    if (u.endsWith("/api/v1/session")) {
      if (!headers.authorization?.startsWith("Bearer ")) return new Response("{}", { status: 401 });
      const signup = typeof body?.username === "string";
      return json(signup ? { apiKey: opts.apiKeyOnSignup ?? "key-123" } : {}, {
        authorization: `Bearer ${jwt({ sub: "sess", exp: inAnHour })}`,
      });
    }
    if (u.endsWith("/api/v1/capability")) {
      return json({}, { authorization: `Bearer ${jwt({ sub: "cap", exp: Math.floor(Date.now() / 1000) + 120 })}` });
    }
    if (u.endsWith("/.well-known/jmap")) {
      return json({
        apiUrl: "https://api.test/jmap",
        primaryAccounts: { "urn:ietf:params:jmap:mail": "acc-1" },
        username: "atag-abc123@atomicmail.ai",
      });
    }
    if (u === "https://api.test/jmap") {
      const responses = (body.methodCalls as [string, Record<string, unknown>, string][]).map(([name, args, id]) => {
        if (name === "Mailbox/query") return ["Mailbox/query", { ids: [`mb-${(args.filter as { role: string }).role}`] }, id];
        if (name === "Email/set") return ["Email/set", { created: { d1: { id: "em-1" } } }, id];
        if (name === "Identity/get") return ["Identity/get", { list: [{ id: "ident-7", email: "atag-abc123@atomicmail.ai" }] }, id];
        if (name === "EmailSubmission/set") return ["EmailSubmission/set", { created: { s1: { id: "sub-1" } } }, id];
        if (name === "Email/query") return ["Email/query", { ids: ["em-9"] }, id];
        if (name === "Email/get") {
          return [
            "Email/get",
            { list: [{ id: "em-9", from: [{ email: "boss@example.com", name: "Boss" }], subject: "hi", receivedAt: "2026-09-09T01:00:00Z", preview: "hello", keywords: {} }] },
            id,
          ];
        }
        return ["error", { type: "unknownMethod" }, id];
      });
      return json({ methodResponses: responses });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("solveProofOfWork", () => {
  it("finds a nonce whose scrypt digest starts with the required zero bits", async () => {
    const solved = await solveProofOfWork("chal-1", 1);
    expect(solved.powHex).toMatch(/^[0-9a-f]{128}$/);
    // One leading zero bit: the first byte is < 0x80.
    expect(parseInt(solved.powHex.slice(0, 2), 16)).toBeLessThan(0x80);
    expect(Number(solved.nonce)).toBeGreaterThanOrEqual(0);
  });
});

describe("AtomicMailClient", () => {
  it("registers: challenge → proof → session with username, returns key, address and account", async () => {
    const { calls, fetchImpl } = fakeAtomicMail();
    const client = new AtomicMailClient({ fetchImpl, authUrl: "https://auth.test", apiUrl: "https://api.test" });
    const reg = await client.register("atag-abc123");
    expect(reg).toMatchObject({ address: "atag-abc123@atomicmail.ai", accountId: "acc-1", apiKey: "key-123" });
    expect(reg.sessionExpiresAt).toBeGreaterThan(Date.now());
    expect(calls.map((c) => c.url)).toEqual([
      "https://auth.test/api/v1/challenge",
      "https://auth.test/api/v1/session",
      "https://auth.test/api/v1/capability",
      "https://api.test/.well-known/jmap",
    ]);
    const session = calls[1]!;
    expect(session.headers.authorization).toMatch(/^Bearer /);
    expect(session.body).toMatchObject({ username: "atag-abc123", nonce: expect.any(String), powHex: expect.any(String) });
    expect(decodeJwtPayload(session.headers.authorization!.slice(7)).jti).toBe("chal-1");
  });

  it("rejects a username outside 5–21 characters before any request", async () => {
    const { calls, fetchImpl } = fakeAtomicMail();
    const client = new AtomicMailClient({ fetchImpl });
    await expect(client.register("ab")).rejects.toThrow(/5–21/);
    expect(calls).toEqual([]);
  });

  it("logs in with the API key and sends a mail as one Email/set + EmailSubmission/set batch", async () => {
    const { calls, fetchImpl } = fakeAtomicMail();
    const client = new AtomicMailClient({ fetchImpl, authUrl: "https://auth.test", apiUrl: "https://api.test" });
    const session = await client.login("key-123");
    expect(calls[1]!.body).toMatchObject({ apiKey: "key-123" });
    const id = await client.send(session, { to: "boss@example.com", subject: "hi", text: "plain", html: "<b>rich</b>" });
    expect(id).toBe("sub-1");
    const batch = calls.at(-1)!;
    expect(batch.headers.authorization).toMatch(/^Bearer /);
    const [emailSet, submission] = (batch.body as { methodCalls: [string, Record<string, unknown>][] }).methodCalls;
    expect(emailSet[0]).toBe("Email/set");
    const draft = (emailSet[1].create as Record<string, Record<string, unknown>>).d1;
    expect(draft).toMatchObject({
      mailboxIds: { "mb-drafts": true },
      from: [{ email: "atag-abc123@atomicmail.ai", name: "Atomic Agent" }],
      to: [{ email: "boss@example.com" }],
      subject: "hi",
      bodyValues: { t: { value: "plain" }, h: { value: "<b>rich</b>" } },
    });
    expect(submission[0]).toBe("EmailSubmission/set");
    expect(submission[1]).toMatchObject({
      create: { s1: { emailId: "#d1", identityId: "ident-7", envelope: { mailFrom: { email: "atag-abc123@atomicmail.ai" }, rcptTo: [{ email: "boss@example.com" }] } } },
    });
    // A second send reuses the drafts mailbox and identity: one JMAP round trip.
    const before = calls.length;
    await client.send(session, { to: "boss@example.com", subject: "again", text: "x" });
    expect(calls.length - before).toBe(1);
    // The capability + discovery are cached within their two minutes.
    expect(calls.filter((c) => c.url.endsWith("/capability"))).toHaveLength(1);
  });

  it("lists the inbox newest first with sender, subject and unread flag", async () => {
    const { fetchImpl } = fakeAtomicMail();
    const client = new AtomicMailClient({ fetchImpl, authUrl: "https://auth.test", apiUrl: "https://api.test" });
    const session = await client.login("key-123");
    const list = await client.listInbox(session, 5);
    expect(list).toEqual([
      { id: "em-9", from: "Boss <boss@example.com>", subject: "hi", receivedAt: "2026-09-09T01:00:00Z", preview: "hello", unread: true },
    ]);
  });

  it("surfaces the service's hint on a refusal", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/challenge")) {
        return new Response(JSON.stringify({ error: { message: "nope", hint: "try again later" } }), { status: 429 });
      }
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    const client = new AtomicMailClient({ fetchImpl });
    await expect(client.login("k")).rejects.toThrow(/challenge failed: HTTP 429 — try again later/);
  });

  it("knows when a cached session is still worth using", () => {
    const now = Date.now();
    expect(AtomicMailClient.sessionIsFresh({ sessionJwt: "x", sessionExpiresAt: now + 3_600_000 }, now)).toBe(true);
    expect(AtomicMailClient.sessionIsFresh({ sessionJwt: "x", sessionExpiresAt: now + 30_000 }, now)).toBe(false);
    expect(AtomicMailClient.sessionIsFresh(null, now)).toBe(false);
  });
});
