import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoogleChatChannel, type GoogleChatChannelDeps } from "./googlechat-channel.js";
import { GOOGLE_CHAT_CHANNEL } from "./index.js";

const OWNER = "users/111";
const SPACE = "spaces/AAA";
const SUB = "projects/p1/subscriptions/chat-sub";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const KEY_JSON = JSON.stringify({
  type: "service_account",
  client_email: "bot@p1.iam.gserviceaccount.com",
  private_key: privateKey,
  private_key_id: "kid",
});

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "atomic-googlechat-channel-"));
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function event(user: string, text: string, n = 1): { ackId: string; message: { data: string } } {
  const payload = {
    type: "MESSAGE",
    space: { name: SPACE },
    message: { name: `${SPACE}/messages/m${n}`, text, thread: { name: `${SPACE}/threads/t1` } },
    user: { name: user, type: "HUMAN" },
  };
  return { ackId: `ack-${n}`, message: { data: Buffer.from(JSON.stringify(payload)).toString("base64") } };
}

/** Token endpoint, scripted pulls (then a pull that parks until aborted), acks and sends recorded. */
function fakeGoogle(pulls: unknown[][], tokenResponse: () => Response = () => json({ access_token: "ya29.t", expires_in: 3600 })) {
  const acks: string[][] = [];
  const sends: Array<{ url: string; body: { text: string; thread?: { name: string } } }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") return tokenResponse();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith(":pull")) {
      const next = pulls.shift();
      if (next) return json({ receivedMessages: next });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    if (url.endsWith(":acknowledge")) {
      acks.push(body.ackIds);
      return json({});
    }
    sends.push({ url, body });
    return json({ name: `${SPACE}/messages/out` });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, acks, sends };
}

function makeChannel(over: Partial<GoogleChatChannelDeps> = {}) {
  const statuses: Array<{ state: string; lastError?: string }> = [];
  const lock = { acquire: vi.fn(), release: vi.fn() };
  const runTurn = vi.fn(async (_s: unknown, _t: string, opts: { eventHook?: (e: unknown) => void }) => {
    opts.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: "done" } });
    return {};
  });
  const channel = new GoogleChatChannel({
    runtime: { runTurn, createSession: () => ({ id: "s1" }), sessionStore: { load: () => null } } as never,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    approvals: { resolve: vi.fn() } as never,
    approvalRouter: { setForSession: vi.fn(() => vi.fn()) } as never,
    channelConfig: { enabled: true, ownerIds: [OWNER], options: { subscription: SUB } },
    stateDir,
    emitStatus: (s) => statuses.push(s),
    lock,
    credentialsPath: "/keys/sa.json",
    readFileImpl: vi.fn(async () => KEY_JSON),
    backoff: () => 1,
    ...over,
  });
  return { channel, statuses, lock, runTurn };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("GoogleChatChannel", () => {
  it("is registered in the catalog as 'googlechat' on every platform", () => {
    expect(GOOGLE_CHAT_CHANNEL.id).toBe("googlechat");
    expect(GOOGLE_CHAT_CHANNEL.platforms).toBeUndefined();
  });

  it("stays disabled when off, without a key path or without a subscription", async () => {
    const cases: Array<Partial<GoogleChatChannelDeps>> = [
      { channelConfig: { enabled: false, ownerIds: [OWNER], options: { subscription: SUB } } },
      { credentialsPath: null },
      { channelConfig: { enabled: true, ownerIds: [OWNER], options: {} } },
      { channelConfig: { enabled: true, ownerIds: [OWNER], options: { subscription: "chat-sub" } } },
    ];
    for (const over of cases) {
      const { channel, lock } = makeChannel(over);
      await channel.start();
      expect(channel.state()).toBe("disabled");
      expect(lock.acquire).not.toHaveBeenCalled();
    }
  });

  it("goes down with a message that never contains the key when the file is bad", async () => {
    const { channel, lock } = makeChannel({ readFileImpl: async () => `{"private_key": "${privateKey.slice(0, 80)}"` });
    await channel.start();
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toMatch(/not valid JSON/);
    expect(channel.lastError()).not.toContain("PRIVATE KEY");
    expect(lock.acquire).not.toHaveBeenCalled();
  });

  it("runs an owner's message, replies in the thread, and acks", async () => {
    const google = fakeGoogle([[event(OWNER, "hello")]]);
    const { channel, runTurn, statuses } = makeChannel({ fetchImpl: google.fetchImpl });
    await channel.start();
    await settle();
    expect(channel.state()).toBe("up");
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(google.acks).toEqual([["ack-1"]]);
    expect(google.sends).toEqual([
      {
        url: `https://chat.googleapis.com/v1/${SPACE}/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`,
        body: { text: "done", thread: { name: `${SPACE}/threads/t1` } },
      },
    ]);
    await channel.stop();
    expect(channel.state()).toBe("disabled");
    expect(statuses.map((s) => s.state)).toEqual(["starting", "up", "stopping", "disabled"]);
  });

  it("ignores a non-owner and undecodable data but still acks both", async () => {
    const google = fakeGoogle([[event("users/999", "hello"), { ackId: "junk", message: { data: "!!" } }]]);
    const { channel, runTurn } = makeChannel({ fetchImpl: google.fetchImpl });
    await channel.start();
    await settle();
    expect(runTurn).not.toHaveBeenCalled();
    expect(google.sends).toEqual([]);
    expect(google.acks).toEqual([["ack-1", "junk"]]);
    await channel.stop();
  });

  it("drops a Pub/Sub redelivery of a message it already handled", async () => {
    const google = fakeGoogle([[event(OWNER, "hello")], [event(OWNER, "hello")]]);
    const { channel, runTurn } = makeChannel({ fetchImpl: google.fetchImpl });
    await channel.start();
    await settle();
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(google.acks).toEqual([["ack-1"], ["ack-1"]]);
    await channel.stop();
  });

  it("goes down when Google rejects the key, without leaking the assertion", async () => {
    const google = fakeGoogle([], () => json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, 400));
    const { channel, lock } = makeChannel({ fetchImpl: google.fetchImpl });
    await channel.start();
    await settle();
    expect(channel.state()).toBe("down");
    expect(channel.lastError()).toContain("invalid_grant");
    expect(channel.lastError()).not.toContain("eyJ");
    expect(lock.release).toHaveBeenCalled();
  });

  it("stop() is idempotent and releases the lock once", async () => {
    const google = fakeGoogle([]);
    const { channel, lock } = makeChannel({ fetchImpl: google.fetchImpl });
    await channel.start();
    await channel.stop();
    await channel.stop();
    expect(lock.release).toHaveBeenCalledTimes(1);
  });
});
