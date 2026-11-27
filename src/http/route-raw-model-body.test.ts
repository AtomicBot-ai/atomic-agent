import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpServer, type HttpServerHandle } from "./http-server.js";
import { BodyTooLargeError, MAX_JSON_BODY_BYTES, readRawBody } from "./request-context.js";
import { RAW_MODEL_MAX_BODY_BYTES, type RawModelShareDeps } from "./route-raw-model.js";
import { buildRouteTable } from "./route-table.js";

/**
 * ATO-2483: the shared model route takes bodies up to
 * RAW_MODEL_MAX_BODY_BYTES (a chat with inline photos), every other route
 * keeps the 1 MiB cap, and the larger cap only applies after the share key
 * was checked.
 */

const AGENT_KEY = "agent-key-0123456789abcdef";
const SHARE_KEY = "share-key-fedcba9876543210";

let handle: HttpServerHandle | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
});

interface Upstream {
  calls: number;
  bytes: number;
}

async function start(): Promise<{ base: string; upstream: Upstream }> {
  const upstream: Upstream = { calls: 0, bytes: 0 };
  const deps: RawModelShareDeps = {
    isEnabled: () => true,
    readKey: () => SHARE_KEY,
    upstream: () => ({ baseUrl: "http://127.0.0.1:9", apiKey: null }),
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      upstream.calls += 1;
      upstream.bytes = init?.body instanceof Uint8Array ? init.body.byteLength : 0;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  };
  handle = await createHttpServer({
    runtime: {} as never,
    host: "127.0.0.1",
    port: 0,
    apiKey: AGENT_KEY,
    routes: buildRouteTable({ rawModel: deps }),
  });
  return { base: `http://127.0.0.1:${handle.port}`, upstream };
}

/** A chat body of about `bytes` bytes: one inline PNG as a data: URL. */
function photoChat(bytes: number): string {
  const data = "A".repeat(bytes);
  return JSON.stringify({
    model: "any",
    messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } }] }],
  });
}

function post(base: string, body: string, key: string | null): Promise<Response> {
  return fetch(`${base}/raw/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body,
  });
}

describe("raw model route body cap (ATO-2483)", () => {
  it("forwards a 5 MiB chat with an inline photo instead of answering 413", async () => {
    const { base, upstream } = await start();
    const body = photoChat(5 * 1024 * 1024);
    const res = await post(base, body, SHARE_KEY);
    expect(res.status).toBe(200);
    expect(upstream.calls).toBe(1);
    expect(upstream.bytes).toBe(Buffer.byteLength(body));
  });

  it("still has a cap of its own, above the 1 MiB of every other route", async () => {
    expect(RAW_MODEL_MAX_BODY_BYTES).toBeGreaterThan(MAX_JSON_BODY_BYTES);
    const err = await readRawBody(fakeRequest(RAW_MODEL_MAX_BODY_BYTES + 1), RAW_MODEL_MAX_BODY_BYTES).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BodyTooLargeError);
    // A 413 is what handleRouteError (http-server.ts) makes of this error.
    expect((err as Error).message).toContain(String(RAW_MODEL_MAX_BODY_BYTES));
  });

  it("checks the key before reading a big body: no key gets 401 and nothing is forwarded", async () => {
    const { base, upstream } = await start();
    const res = await post(base, photoChat(5 * 1024 * 1024), null);
    expect(res.status).toBe(401);
    expect(upstream.calls).toBe(0);
  });
});

function fakeRequest(bytes: number): IncomingMessage {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  let left = bytes;
  return Readable.from((function* () {
    while (left > 0) {
      const n = Math.min(left, chunk.length);
      left -= n;
      yield chunk.subarray(0, n);
    }
  })()) as unknown as IncomingMessage;
}

describe("readRawBody cap", () => {
  it("keeps 1 MiB for every route that passes no cap", async () => {
    await expect(readRawBody(fakeRequest(MAX_JSON_BODY_BYTES + 1))).rejects.toBeInstanceOf(BodyTooLargeError);
    expect((await readRawBody(fakeRequest(MAX_JSON_BODY_BYTES))).length).toBe(MAX_JSON_BODY_BYTES);
  });

  it("takes a larger cap when a route passes one, and names it when exceeded", async () => {
    const twoMiB = 2 * 1024 * 1024;
    expect((await readRawBody(fakeRequest(twoMiB), twoMiB)).length).toBe(twoMiB);
    const err = await readRawBody(fakeRequest(twoMiB + 1), twoMiB).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BodyTooLargeError);
    expect((err as BodyTooLargeError).limit).toBe(twoMiB);
    expect((err as Error).message).toContain(String(twoMiB));
  });
});
