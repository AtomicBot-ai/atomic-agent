import { describe, expect, it, vi } from "vitest";

import { MatrixApi, MatrixApiError, retryAfterMs } from "./matrix-api.js";

const TOKEN = "syt_Ym90_abcdefghijklmnopqrst_0a1b2c";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function makeApi(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async () => undefined);
  const api = new MatrixApi({
    homeserver: "https://hs.example",
    token: TOKEN,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep,
  });
  return { api, calls, sleep };
}

describe("MatrixApi", () => {
  it("whoami sends the bearer token and returns the user id", async () => {
    const { api, calls } = makeApi([json({ user_id: "@bot:hs.example" })]);
    await expect(api.whoami()).resolves.toBe("@bot:hs.example");
    expect(calls[0]?.url).toBe("https://hs.example/_matrix/client/v3/account/whoami");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("sync passes since, timeout and the filter", async () => {
    const { api, calls } = makeApi([json({ next_batch: "s2" })]);
    const res = await api.sync("s1", 30_000);
    expect(res.next_batch).toBe("s2");
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/_matrix/client/v3/sync");
    expect(url.searchParams.get("since")).toBe("s1");
    expect(url.searchParams.get("timeout")).toBe("30000");
    expect(JSON.parse(url.searchParams.get("filter") ?? "{}").room.timeline.types).toEqual([
      "m.room.message",
      "m.room.encrypted",
    ]);
  });

  it("initial sync sends no since", async () => {
    const { api, calls } = makeApi([json({ next_batch: "s1" })]);
    await api.sync(null, 0);
    expect(new URL(calls[0]?.url ?? "").searchParams.has("since")).toBe(false);
  });

  it("sends a message with a PUT, a fresh txn id per chunk and HTML when needed", async () => {
    const { api, calls } = makeApi([json({ event_id: "$1" }), json({ event_id: "$2" })]);
    const long = `**a**\n\n${"x".repeat(9000)}`;
    await expect(api.sendMessage("!room:hs", long)).resolves.toBe("$2");
    expect(calls).toHaveLength(2);
    const [first, second] = calls;
    expect(first?.init.method).toBe("PUT");
    expect(first?.url).toMatch(
      /\/_matrix\/client\/v3\/rooms\/!room%3Ahs\/send\/m\.room\.message\/atomic-[a-z0-9]+-1$/,
    );
    expect(second?.url).toMatch(/-2$/);
    const body = JSON.parse(String(first?.init.body));
    expect(body.msgtype).toBe("m.text");
    expect(body.formatted_body).toContain("<b>a</b>");
    expect(body.body.length).toBeLessThanOrEqual(8000);
  });

  it("sends notices as m.notice", async () => {
    const { api, calls } = makeApi([json({ event_id: "$1" })]);
    await api.sendNotice("!r:hs", "hello");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ msgtype: "m.notice", body: "hello" });
  });

  it("waits retry_after_ms on 429 and retries with the same txn id", async () => {
    const { api, calls, sleep } = makeApi([
      json({ errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 1234 }, 429),
      json({ event_id: "$1" }),
    ]);
    await api.sendNotice("!r:hs", "hi");
    expect(sleep).toHaveBeenCalledWith(1234);
    expect(calls[0]?.url).toBe(calls[1]?.url);
  });

  it("gives up after a few rate-limit retries", async () => {
    const limited = () => json({ errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 10 }, 429);
    const { api } = makeApi([limited(), limited(), limited(), limited()]);
    await expect(api.sendNotice("!r:hs", "hi")).rejects.toBeInstanceOf(MatrixApiError);
  });

  it("marks a rejected token fatal and never echoes it", async () => {
    const { api } = makeApi([json({ errcode: "M_UNKNOWN_TOKEN", error: `bad ${TOKEN}` }, 401)]);
    const err = (await api.whoami().catch((e: unknown) => e)) as MatrixApiError;
    expect(err).toBeInstanceOf(MatrixApiError);
    expect(err.fatal).toBe(true);
    expect(err.errcode).toBe("M_UNKNOWN_TOKEN");
    expect(err.message).not.toContain(TOKEN);
  });

  it("wraps a network failure as a non-fatal error with the token scrubbed", async () => {
    const { api } = makeApi([new Error(`connect ECONNREFUSED ?access_token=${TOKEN}`)]);
    const err = (await api.whoami().catch((e: unknown) => e)) as MatrixApiError;
    expect(err.status).toBe(0);
    expect(err.fatal).toBe(false);
    expect(err.message).not.toContain(TOKEN);
  });

  it("joins, leaves and sets typing on the right paths", async () => {
    const { api, calls } = makeApi([json({}), json({}), json({})]);
    await api.joinRoom("!r:hs");
    await api.leaveRoom("!r:hs");
    await api.setTyping("!r:hs", "@bot:hs", true);
    expect(calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([
      ["POST", "/_matrix/client/v3/join/!r%3Ahs"],
      ["POST", "/_matrix/client/v3/rooms/!r%3Ahs/leave"],
      ["PUT", "/_matrix/client/v3/rooms/!r%3Ahs/typing/%40bot%3Ahs"],
    ]);
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ typing: true, timeout: 30_000 });
  });
});

describe("retryAfterMs", () => {
  it("prefers the body, then the header, then a default, capped at 30 s", () => {
    const headers = (h: Record<string, string>) => ({ headers: new Headers(h) });
    expect(retryAfterMs({ retry_after_ms: 500 }, headers({}))).toBe(500);
    expect(retryAfterMs(undefined, headers({ "retry-after": "2" }))).toBe(2000);
    expect(retryAfterMs(undefined, headers({}))).toBe(1000);
    expect(retryAfterMs({ retry_after_ms: 999_999 }, headers({}))).toBe(30_000);
  });
});
