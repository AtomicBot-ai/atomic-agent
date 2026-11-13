import { describe, expect, it, vi } from "vitest";

import { SlackApi, SlackApiError, retryAfterMs } from "./slack-api.js";

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

function makeApi(fetchImpl: ReturnType<typeof vi.fn>, sleep = vi.fn(async () => {})) {
  return {
    api: new SlackApi({
      botToken: "xoxb-bot",
      appToken: "xapp-app",
      baseUrl: "https://slack.invalid/api",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    }),
    sleep,
  };
}

describe("SlackApi", () => {
  it("auth.test uses the bot token and returns the bot user id", async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, user_id: "UBOT", team_id: "T1" }));
    const { api } = makeApi(fetchImpl);
    await expect(api.authTest()).resolves.toEqual({ userId: "UBOT", teamId: "T1" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://slack.invalid/api/auth.test");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-bot");
  });

  it("apps.connections.open uses the app-level token", async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, url: "wss://x.invalid/link" }));
    const { api } = makeApi(fetchImpl);
    await expect(api.openConnection()).resolves.toBe("wss://x.invalid/link");
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xapp-app");
  });

  it("throws the Slack error code on ok:false", async () => {
    const { api } = makeApi(vi.fn(async () => json({ ok: false, error: "invalid_auth" })));
    const err = await api.authTest().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect((err as SlackApiError).code).toBe("invalid_auth");
  });

  it("waits out a 429 Retry-After and retries", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(json({ ok: true, ts: "1.2" }));
    const { api, sleep } = makeApi(fetchImpl);
    await expect(api.postMessage({ channel: "C1" }, "hi")).resolves.toBe("1.2");
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry budget", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 429, headers: { "Retry-After": "1" } }));
    const { api } = makeApi(fetchImpl);
    const err = await api.postMessage({ channel: "C1" }, "hi").catch((e: unknown) => e);
    expect((err as SlackApiError).code).toBe("ratelimited");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("posts in the thread and without unfurls", async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, ts: "9.9" }));
    const { api } = makeApi(fetchImpl);
    await api.postMessage({ channel: "C1", threadTs: "1.0" }, "hi");
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      channel: "C1",
      text: "hi",
      thread_ts: "1.0",
      unfurl_links: false,
    });
  });

  it("postText splits a long reply into ordered chunks", async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, ts: "1" }));
    const { api } = makeApi(fetchImpl);
    await api.postText({ channel: "D1" }, `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const texts = fetchImpl.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)).text);
    expect(texts[0]).toMatch(/^a+$/);
    expect(texts[1]).toMatch(/^b+$/);
  });
});

describe("SlackApi.respond", () => {
  it("posts an ephemeral reply to the hooks URL", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const { api } = makeApi(fetchImpl);
    await api.respond("https://hooks.slack.com/commands/T1/1/x", "no");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.slack.com/commands/T1/1/x");
    expect(JSON.parse(String(init.body))).toEqual({ response_type: "ephemeral", text: "no" });
  });

  it("refuses a response_url that is not Slack's", async () => {
    const fetchImpl = vi.fn();
    const { api } = makeApi(fetchImpl);
    await expect(api.respond("https://evil.example/hook", "x")).rejects.toThrow(/hooks.slack.com/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("retryAfterMs", () => {
  it("reads seconds and falls back to one second", () => {
    expect(retryAfterMs("3")).toBe(3000);
    expect(retryAfterMs(null)).toBe(1000);
    expect(retryAfterMs("soon")).toBe(1000);
  });
});
