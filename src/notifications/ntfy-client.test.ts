import { describe, expect, it, vi } from "vitest";

import type { PushNotifyConfig } from "../config/index.js";
import {
  PUSH_BODY_MAX,
  cleanPushText,
  generatePushTopic,
  isPushReady,
  pushSubscribeUrl,
  sendPush,
} from "./ntfy-client.js";

const push: PushNotifyConfig = {
  enabled: true,
  server: "https://ntfy.example.com",
  topic: "atag-test-topic",
  tokenEnv: "NTFY_TOKEN",
};

function fakeFetch(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function sentBody(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe("generatePushTopic", () => {
  it("mints a long, ntfy-safe, different topic every time", () => {
    const a = generatePushTopic();
    const b = generatePushTopic();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^atag-[-_A-Za-z0-9]{24}$/);
  });
});

describe("isPushReady / pushSubscribeUrl", () => {
  it("needs the switch on and a topic", () => {
    expect(isPushReady(push)).toBe(true);
    expect(isPushReady({ ...push, enabled: false })).toBe(false);
    expect(isPushReady({ ...push, topic: null })).toBe(false);
    expect(isPushReady(undefined)).toBe(false);
    expect(pushSubscribeUrl(push)).toBe("https://ntfy.example.com/atag-test-topic");
    expect(pushSubscribeUrl({ ...push, topic: null })).toBeNull();
  });
});

describe("cleanPushText", () => {
  it("drops control characters, folds whitespace and clips with an ellipsis", () => {
    expect(cleanPushText("a\u0007b\n\n c\u001b[31m", 100)).toBe("a b c [31m");
    const long = cleanPushText("x".repeat(500), 10);
    expect(Array.from(long)).toHaveLength(10);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("sendPush", () => {
  it("POSTs JSON to the server root with the topic, title and a clipped body", async () => {
    const { impl, calls } = fakeFetch();
    const result = await sendPush({
      push,
      message: { title: "Turn done ✅", body: "y".repeat(1000), tags: ["white_check_mark"] },
      env: {},
      fetchImpl: impl,
    });
    expect(result).toEqual({ outcome: "sent" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://ntfy.example.com/");
    expect(calls[0]!.init.method).toBe("POST");
    const body = sentBody(calls[0]!);
    expect(body).toMatchObject({
      topic: "atag-test-topic",
      title: "Turn done ✅",
      tags: ["white_check_mark"],
      priority: 3,
    });
    expect(Array.from(String(body.message))).toHaveLength(PUSH_BODY_MAX);
    // No auth header without a token.
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends the access token from the env as a bearer header", async () => {
    const { impl, calls } = fakeFetch();
    await sendPush({
      push,
      message: { title: "t", body: "b" },
      env: { NTFY_TOKEN: "tk_abcdefghijklmnop" },
      fetchImpl: impl,
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tk_abcdefghijklmnop");
  });

  it("masks the agent's own secrets and key shapes before anything leaves", async () => {
    const { impl, calls } = fakeFetch();
    const key = "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    await sendPush({
      push,
      message: {
        title: "done",
        body: `Your key is ${key} and the bot token is SECRETVALUE12345`,
      },
      env: { TELEGRAM_BOT_TOKEN: "SECRETVALUE12345" },
      fetchImpl: impl,
    });
    const message = String(sentBody(calls[0]!).message);
    expect(message).not.toContain(key);
    expect(message).not.toContain("SECRETVALUE12345");
    expect(message).toContain("[redacted:");
  });

  it("sends nothing when push is off or has no topic", async () => {
    const { impl, calls } = fakeFetch();
    expect(
      await sendPush({ push: { ...push, enabled: false }, message: { title: "t", body: "b" }, fetchImpl: impl }),
    ).toEqual({ outcome: "not_configured", reason: "push is off" });
    expect(
      await sendPush({ push: { ...push, topic: null }, message: { title: "t", body: "b" }, fetchImpl: impl }),
    ).toEqual({ outcome: "not_configured", reason: "no topic" });
    expect(calls).toHaveLength(0);
  });

  it("reports an HTTP refusal once, with a hint and without the topic", async () => {
    const { impl, calls } = fakeFetch(403);
    const result = await sendPush({ push, message: { title: "t", body: "b" }, env: {}, fetchImpl: impl });
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.reason).toMatch(/ntfy answered 403/);
      expect(result.reason).toMatch(/NTFY_TOKEN/);
      expect(result.reason).not.toContain(push.topic!);
    }
    expect(calls).toHaveLength(1);
  });

  it("never throws: a network error or a timeout is a failed result, one attempt", async () => {
    const boom = vi.fn(async () => {
      throw Object.assign(new TypeError(`fetch failed for https://ntfy.example.com/${push.topic}`), {
        cause: { code: "ECONNREFUSED" },
      });
    }) as unknown as typeof fetch;
    const result = await sendPush({ push, message: { title: "t", body: "b" }, env: {}, fetchImpl: boom });
    expect(result).toEqual({ outcome: "failed", reason: "network error (ECONNREFUSED)" });
    expect(boom).toHaveBeenCalledTimes(1);

    const slow = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })),
          );
        }),
    ) as unknown as typeof fetch;
    const timed = await sendPush({
      push,
      message: { title: "t", body: "b" },
      env: {},
      fetchImpl: slow,
      timeoutMs: 20,
    });
    expect(timed).toEqual({ outcome: "failed", reason: "timed out" });
  });
});
