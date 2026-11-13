import { describe, expect, it, vi } from "vitest";

import { GoogleChatApi, GoogleChatApiError } from "./googlechat-api.js";

const SUB = "projects/p1/subscriptions/chat-sub";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function makeApi(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get("authorization"),
    });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next ?? json({});
  });
  const tokens = { token: vi.fn(async () => "ya29.tok"), invalidate: vi.fn() };
  const sleep = vi.fn(async () => undefined);
  const api = new GoogleChatApi({ tokens, fetchImpl: fetchImpl as unknown as typeof fetch, sleep });
  return { api, calls, tokens, sleep };
}

describe("GoogleChatApi", () => {
  it("pulls from the subscription with a bearer token and keeps only well-formed messages", async () => {
    const { api, calls } = makeApi([
      json({ receivedMessages: [{ ackId: "a1", message: { data: "e30=" } }, { message: {} }] }),
    ]);
    const got = await api.pull(SUB, 10, new AbortController().signal, 1000);
    expect(got).toEqual([{ ackId: "a1", message: { data: "e30=" } }]);
    expect(calls[0]).toEqual({
      url: `https://pubsub.googleapis.com/v1/${SUB}:pull`,
      body: { maxMessages: 10 },
      auth: "Bearer ya29.tok",
    });
  });

  it("reads an empty pull as no messages", async () => {
    const { api } = makeApi([json({})]);
    expect(await api.pull(SUB, 10, new AbortController().signal, 1000)).toEqual([]);
  });

  it("acknowledges the given ack ids and skips an empty list", async () => {
    const { api, calls } = makeApi([json({})]);
    await api.acknowledge(SUB, []);
    expect(calls).toHaveLength(0);
    await api.acknowledge(SUB, ["a1", "a2"]);
    expect(calls[0]?.url).toBe(`https://pubsub.googleapis.com/v1/${SUB}:acknowledge`);
    expect(calls[0]?.body).toEqual({ ackIds: ["a1", "a2"] });
  });

  it("replies in the thread, falling back to a new one", async () => {
    const { api, calls } = makeApi([json({ name: "spaces/AAA/messages/m1" })]);
    const name = await api.createMessage("spaces/AAA", "hello", "spaces/AAA/threads/t1");
    expect(name).toBe("spaces/AAA/messages/m1");
    expect(calls[0]?.url).toBe(
      "https://chat.googleapis.com/v1/spaces/AAA/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD",
    );
    expect(calls[0]?.body).toEqual({ text: "hello", thread: { name: "spaces/AAA/threads/t1" } });
  });

  it("posts without a thread when the thread belongs to another space or is malformed", async () => {
    const { api, calls } = makeApi([json({}), json({})]);
    await api.createMessage("spaces/AAA", "hi", "spaces/BBB/threads/t1");
    await api.createMessage("spaces/AAA", "hi", "spaces/AAA/threads/../x");
    expect(calls.map((c) => c.url)).toEqual([
      "https://chat.googleapis.com/v1/spaces/AAA/messages",
      "https://chat.googleapis.com/v1/spaces/AAA/messages",
    ]);
    expect(calls[0]?.body).toEqual({ text: "hi" });
  });

  it("refuses a malformed space name before any request", async () => {
    const { api, calls } = makeApi([]);
    await expect(api.createMessage("spaces/../projects", "x")).rejects.toBeInstanceOf(GoogleChatApiError);
    expect(calls).toHaveLength(0);
  });

  it("retries a 429 after Retry-After and a 503 with backoff", async () => {
    const { api, calls, sleep } = makeApi([
      json({ error: { status: "RESOURCE_EXHAUSTED" } }, 429, { "Retry-After": "2" }),
      json({}, 503),
      json({ name: "spaces/AAA/messages/m2" }),
    ]);
    expect(await api.createMessage("spaces/AAA", "x")).toBe("spaces/AAA/messages/m2");
    expect(calls).toHaveLength(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 2000);
  });

  it("gives up after a few retries with a scrubbed error", async () => {
    const { api } = makeApi([json({}, 500), json({}, 500), json({}, 500), json({ error: { message: "Bearer ya29.leak" } }, 500)]);
    const err = (await api.createMessage("spaces/AAA", "x").catch((e: unknown) => e)) as GoogleChatApiError;
    expect(err.status).toBe(500);
    expect(err.fatal).toBe(false);
    expect(err.message).not.toContain("ya29.leak");
  });

  it("drops the cached token on a 401 and retries once", async () => {
    const { api, tokens, calls } = makeApi([json({}, 401), json({ name: "n" })]);
    await api.createMessage("spaces/AAA", "x");
    expect(tokens.invalidate).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });

  it("marks 403 and 404 as fatal and does not retry them", async () => {
    const { api, calls } = makeApi([json({ error: { status: "NOT_FOUND" } }, 404)]);
    const err = (await api.pull(SUB, 10, new AbortController().signal, 1000).catch((e: unknown) => e)) as GoogleChatApiError;
    expect(err.fatal).toBe(true);
    expect(err.message).toContain("NOT_FOUND");
    expect(calls).toHaveLength(1);
  });
});
