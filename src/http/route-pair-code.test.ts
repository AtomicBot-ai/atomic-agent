import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEVICE_COOKIE } from "./device-auth.js";
import { MAX_CODE_FAILURES, MAX_CODE_FAILURES_PER_ADDRESS } from "./device-code.js";
import { createDeviceSessions, type DeviceSessions } from "./device-sessions.js";
import { DEVICE_IDLE_MS, PAIRING_TTL_MS } from "./device-store.js";
import { createHttpServer, type HttpServerHandle, type RouteDefinition } from "./http-server.js";
import { sendJson } from "./request-context.js";
import { buildRouteTable } from "./route-table.js";

/**
 * ATO-2494 on the real route table: the short code typed at /panel/pair
 * (the iPhone home-screen app, which has its own cookies) pairs like the
 * QR link, wrong codes stop working after MAX_CODE_FAILURES, and a device
 * cookie slides: 30 days, sent again on use, refused after 30 idle days.
 */
const KEY = "k".repeat(32);
let dir: string;
let clock: Date;
let devices: DeviceSessions;
const servers: HttpServerHandle[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atag-pair-code-"));
  clock = new Date("2026-11-27T10:00:00.000Z");
  devices = createDeviceSessions(dir, { now: () => clock });
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  rmSync(dir, { recursive: true, force: true });
});

const probe: RouteDefinition = {
  method: "GET",
  path: "/probe",
  handler: (_req, res) => sendJson(res, 200, { ok: true }),
  scope: "read",
};

async function start(): Promise<number> {
  const handle = await createHttpServer({
    runtime: {} as never,
    host: "127.0.0.1",
    port: 0,
    apiKey: KEY,
    routes: [...buildRouteTable({ devices }), probe],
    deviceSessions: devices,
  });
  servers.push(handle);
  return handle.port;
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const postCode = (port: number, code: string, headers: Record<string, string> = {}): Promise<Answer> =>
  call(port, "POST", "/panel/pair", { ...FORM, ...headers }, new URLSearchParams({ code }).toString());
/** As if from another host: serve trusts `cf-connecting-ip` on a loopback socket (the tunnel). */
const from = (address: string): Record<string, string> => ({ "cf-connecting-ip": address });

function newPairing(): { token: string; code: string } {
  const made = devices.createPairing();
  if (!made.ok) throw new Error(made.error);
  return { token: made.token, code: made.code };
}

function setCookie(answer: Answer): string {
  return ([] as string[]).concat(answer.headers["set-cookie"] ?? []).join(";");
}

function cookieFrom(answer: Answer): string {
  const match = new RegExp(`${DEVICE_COOKIE}=([^;]+)`).exec(setCookie(answer));
  if (!match?.[1]) throw new Error("no device cookie");
  return match[1];
}

/** A code from the same alphabet that is not `code`. */
function otherCode(code: string): string {
  return code.startsWith("B") ? `C${code.slice(1)}` : `B${code.slice(1)}`;
}

describe("GET and POST /panel/pair", () => {
  it("GET shows a code form that posts back to itself, inside the panel's app scope", async () => {
    const port = await start();
    const page = await call(port, "GET", "/panel/pair");
    expect(page.status).toBe(200);
    expect(page.body).toContain('<form method="post" action="/panel/pair">');
    expect(page.body).toContain('name="code"');
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("the right code, typed in any case with a dash or not, signs the app in and sends it to the panel", async () => {
    const port = await start();
    const { code } = newPairing();
    const typed = `${code.slice(0, 4).toLowerCase()} - ${code.slice(4)}`;
    const out = await postCode(port, typed);
    expect(out.status).toBe(303);
    expect(out.headers.location).toBe("/panel");
    expect(setCookie(out)).toContain("HttpOnly");
    expect((await call(port, "GET", "/probe", { cookie: `${DEVICE_COOKIE}=${cookieFrom(out)}` })).status).toBe(200);
  });

  it("a code works once, and using it spends the QR link of the same pairing", async () => {
    const port = await start();
    const { token, code } = newPairing();
    expect((await postCode(port, code)).status).toBe(303);
    expect((await postCode(port, code)).status).toBe(400);
    expect((await call(port, "POST", `/pair/${token}`)).status).toBe(410);
  });

  it("a wrong or expired code shows the form again with why, and adds no device", async () => {
    const port = await start();
    const { code } = newPairing();
    const wrong = await postCode(port, otherCode(code));
    expect(wrong.status).toBe(400);
    expect(wrong.body).toContain("This code does not work");
    clock = new Date(clock.getTime() + PAIRING_TTL_MS + 1);
    const late = await postCode(port, code);
    expect(late.status).toBe(400);
    expect(late.body).toContain("expired");
    expect(devices.list()).toEqual([]);
  });

  it(`stops taking codes after ${MAX_CODE_FAILURES} wrong ones from all callers, until a new code is made`, async () => {
    const port = await start();
    const { code } = newPairing();
    for (let i = 0; i < MAX_CODE_FAILURES; i++) {
      await postCode(port, "ZZZZ-ZZZZ", from(`203.0.113.${Math.floor(i / MAX_CODE_FAILURES_PER_ADDRESS) + 1}`));
    }
    const locked = await postCode(port, code, from("198.51.100.7"));
    expect(locked.status).toBe(429);
    expect(locked.body).toContain("Too many wrong codes");
    clock = new Date(clock.getTime() + 1_000);
    const fresh = newPairing();
    expect((await postCode(port, fresh.code)).status).toBe(303);
  });

  it(`one address spends at most ${MAX_CODE_FAILURES_PER_ADDRESS} wrong codes; others still pair`, async () => {
    const port = await start();
    const { code } = newPairing();
    for (let i = 0; i < MAX_CODE_FAILURES_PER_ADDRESS; i++) {
      expect((await postCode(port, "ZZZZ-ZZZZ", from("203.0.113.5"))).status).toBe(400);
    }
    expect((await postCode(port, code, from("203.0.113.5"))).status).toBe(429);
    expect((await postCode(port, code, from("203.0.113.6"))).status).toBe(303);
    // A new code gives the locked-out address its budget back (failuresByAddress.clear()).
    clock = new Date(clock.getTime() + 1_000);
    const fresh = newPairing();
    expect((await postCode(port, fresh.code, from("203.0.113.5"))).status).toBe(303);
  });

  it("posts from another web page are refused and spend none of the budget", async () => {
    const port = await start();
    const { code } = newPairing();
    for (let i = 0; i < MAX_CODE_FAILURES; i++) {
      expect((await postCode(port, "ZZZZ-ZZZZ", { origin: "https://evil.example" })).status).toBe(403);
      expect((await postCode(port, "ZZZZ-ZZZZ", { origin: "null" })).status).toBe(403);
      expect((await postCode(port, "ZZZZ-ZZZZ", { "sec-fetch-site": "cross-site" })).status).toBe(403);
      expect((await postCode(port, "ZZZZ-ZZZZ", { "sec-fetch-site": "same-site" })).status).toBe(403);
    }
    const own = { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" };
    expect((await postCode(port, code, own)).status).toBe(303);
  });

  it("input that cannot be a code spends none of the budget", async () => {
    const port = await start();
    const { code } = newPairing();
    for (let i = 0; i < MAX_CODE_FAILURES + 1; i++) {
      expect((await postCode(port, "x")).status).toBe(400);
    }
    expect((await postCode(port, code)).status).toBe(303);
  });
});

describe("sliding device session (ATO-2494)", () => {
  it("the pairing cookie lasts 30 days, and every signed-in request sends it again", async () => {
    const port = await start();
    const { code } = newPairing();
    const paired = await postCode(port, code);
    const maxAge = `Max-Age=${DEVICE_IDLE_MS / 1000}`;
    expect(setCookie(paired)).toContain(maxAge);
    const secret = cookieFrom(paired);
    const use = await call(port, "GET", "/probe", { cookie: `${DEVICE_COOKIE}=${secret}` });
    expect(use.status).toBe(200);
    expect(setCookie(use)).toContain(`${DEVICE_COOKIE}=${secret}`);
    expect(setCookie(use)).toContain(maxAge);
  });

  it("a phone used within 30 days stays in; one idle past 30 days is signed out and no longer listed", async () => {
    const port = await start();
    const secret = cookieFrom(await postCode(port, newPairing().code));
    const cookie = { cookie: `${DEVICE_COOKIE}=${secret}` };
    clock = new Date(clock.getTime() + DEVICE_IDLE_MS - 60_000);
    expect((await call(port, "GET", "/probe", cookie)).status).toBe(200);
    // That use moved the end forward: another 29 days later it still works.
    clock = new Date(clock.getTime() + DEVICE_IDLE_MS - 60_000);
    expect((await call(port, "GET", "/probe", cookie)).status).toBe(200);
    clock = new Date(clock.getTime() + DEVICE_IDLE_MS + 60_000);
    const idle = await call(port, "GET", "/probe", cookie);
    expect(idle.status).toBe(401);
    expect(setCookie(idle)).toContain(`${DEVICE_COOKIE}=;`);
    expect(devices.list()).toEqual([]);
  });
});
