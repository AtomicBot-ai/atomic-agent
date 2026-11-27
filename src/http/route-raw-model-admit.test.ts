import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { AuthThrottle } from "./auth-throttle.js";
import { createRawModelHandlers, RAW_MODEL_MAX_BODY_BYTES, type RawModelShareDeps } from "./route-raw-model.js";

/**
 * ATO-2483: who the shared model answers, checked on the handler itself
 * with a fake socket address (a real test server only ever sees 127.0.0.1).
 *
 * - "This computer" (local) means local: a caller from another address
 *   gets 404 even on a serve whose own listener is on 0.0.0.0.
 * - Only a wrong key counts as a guess for the auth throttle; requests
 *   with no key (Find on my network) never lock the real app out.
 */

const SHARE_KEY = "share-key-fedcba9876543210";
const LAN_PEER = "192.168.1.23";

interface FakeRes {
  res: ServerResponse;
  status: () => number;
}

function fakeRes(): FakeRes {
  let status = 0;
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writeHead(code: number) {
      status = code;
      return res;
    },
    flushHeaders() {},
    write() {
      return true;
    },
    end() {
      res.writableEnded = true;
      return res;
    },
  });
  return { res: res as unknown as ServerResponse, status: () => status };
}

function fakeReq(remoteAddress: string, key: string | null): IncomingMessage {
  return {
    method: "GET",
    url: "/raw/v1/models",
    headers: key ? { authorization: `Bearer ${key}` } : {},
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

function handlers(overrides: Partial<RawModelShareDeps> = {}) {
  let forwarded = 0;
  const deps: RawModelShareDeps = {
    isEnabled: () => true,
    readKey: () => SHARE_KEY,
    upstream: () => ({ baseUrl: "http://127.0.0.1:9", apiKey: null }),
    fetch: (async () => {
      forwarded += 1;
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
    throttle: new AuthThrottle(),
    ...overrides,
  };
  const raw = createRawModelHandlers(deps);
  const call = async (remoteAddress: string, key: string | null): Promise<number> => {
    const out = fakeRes();
    await raw.models(fakeReq(remoteAddress, key), out.res, {} as never);
    return out.status();
  };
  return { call, raw, forwarded: () => forwarded };
}

describe("raw model route in local mode (ATO-2483)", () => {
  it("answers 404 to a caller from another device, even with the right key, and never reaches the model", async () => {
    const h = handlers({ localOnly: () => true });
    expect(await h.call(LAN_PEER, SHARE_KEY)).toBe(404);
    expect(await h.call(`::ffff:${LAN_PEER}`, SHARE_KEY)).toBe(404);
    expect(h.forwarded()).toBe(0);
  });

  it("still answers apps on this computer", async () => {
    const h = handlers({ localOnly: () => true });
    expect(await h.call("127.0.0.1", SHARE_KEY)).toBe(200);
    expect(await h.call("::ffff:127.0.0.1", SHARE_KEY)).toBe(200);
    expect(await h.call("::1", SHARE_KEY)).toBe(200);
  });

  it("answers other devices in network mode", async () => {
    const h = handlers({ localOnly: () => false });
    expect(await h.call(LAN_PEER, SHARE_KEY)).toBe(200);
  });
});

describe("raw model auth throttle (ATO-2483)", () => {
  it("does not count requests without a key: after many keyless probes the right key still gets 200", async () => {
    const h = handlers();
    for (let i = 0; i < 15; i += 1) expect(await h.call(LAN_PEER, null)).toBe(401);
    expect(await h.call(LAN_PEER, SHARE_KEY)).toBe(200);
  });

  it("still blocks an address that sends wrong keys", async () => {
    const h = handlers();
    for (let i = 0; i < 10; i += 1) expect(await h.call(LAN_PEER, "wrong-key")).toBe(401);
    expect(await h.call(LAN_PEER, SHARE_KEY)).toBe(429);
    expect(h.forwarded()).toBe(0);
  });
});

describe("raw model body is read only after the key (ATO-2483)", () => {
  it("answers 401 to a 33 MiB chat with no key without reading a byte of it (413 would mean it was read first)", async () => {
    const h = handlers();
    let pulled = 0;
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    const total = RAW_MODEL_MAX_BODY_BYTES + 1024 * 1024;
    const body = new Readable({
      read() {
        if (pulled >= total) {
          this.push(null);
          return;
        }
        pulled += chunk.length;
        this.push(chunk);
      },
    });
    const req = Object.assign(body, {
      method: "POST",
      url: "/raw/v1/chat/completions",
      headers: { "content-type": "application/json" },
      socket: { remoteAddress: LAN_PEER },
    }) as unknown as IncomingMessage;
    const out = fakeRes();
    await h.raw.chatCompletions(req, out.res, {} as never);
    expect(out.status()).toBe(401);
    expect(pulled).toBe(0);
    expect(h.forwarded()).toBe(0);
  });
});
