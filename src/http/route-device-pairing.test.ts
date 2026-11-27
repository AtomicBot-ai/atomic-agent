import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEVICE_COOKIE } from "./device-auth.js";
import { createDeviceSessions, type DeviceSessions } from "./device-sessions.js";
import { PAIRING_TTL_MS } from "./device-store.js";
import { createHttpServer, type HttpServerHandle, type RouteDefinition } from "./http-server.js";
import { deviceNameFromUserAgent } from "./route-device-pairing.js";
import { sendJson } from "./request-context.js";
import { buildRouteTable } from "./route-table.js";

/**
 * ATO-2308 end to end on the real route table: `atag pair`'s link opens a
 * page, the button trades it for a device cookie once, the cookie opens
 * the API, and the admin device routes list and revoke.
 */
const KEY = "k".repeat(32);
let dir: string;
let clock: Date;
let devices: DeviceSessions;
const servers: HttpServerHandle[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atag-pair-route-"));
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

function call(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

function newLinkPath(): string {
  const made = devices.createPairing();
  if (!made.ok) throw new Error(made.error);
  return `/pair/${made.token}`;
}

function cookieFrom(answer: Answer): string {
  const raw = ([] as string[]).concat(answer.headers["set-cookie"] ?? []).join(";");
  const match = new RegExp(`${DEVICE_COOKIE}=([^;]+)`).exec(raw);
  if (!match?.[1]) throw new Error("no device cookie");
  return match[1];
}

describe("GET and POST /pair/{token}", () => {
  it("GET shows the Connect button and does not use the link up", async () => {
    const port = await start();
    const path = newLinkPath();
    const page = await call(port, "GET", path);
    expect(page.status).toBe(200);
    expect(page.body).toContain('<form method="post">');
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    // Still good after the GET (a link preview would have spent it otherwise).
    expect((await call(port, "POST", path, { "user-agent": IPHONE })).status).toBe(303);
  });

  it("POST sets an HttpOnly, SameSite=Strict device cookie and sends the phone to the panel", async () => {
    const port = await start();
    const out = await call(port, "POST", newLinkPath(), { "user-agent": IPHONE });
    expect(out.status).toBe(303);
    expect(out.headers.location).toBe("/panel");
    const setCookie = ([] as string[]).concat(out.headers["set-cookie"] ?? []).join(";");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Secure");
    expect(devices.list().map((d) => d.name)).toEqual(["iPhone"]);
  });

  it("the cookie opens the API without a key", async () => {
    const port = await start();
    expect((await call(port, "GET", "/probe")).status).toBe(401);
    const secret = cookieFrom(await call(port, "POST", newLinkPath(), { "user-agent": IPHONE }));
    expect((await call(port, "GET", "/probe", { cookie: `${DEVICE_COOKIE}=${secret}` })).status).toBe(200);
  });

  it("a link works once: the second POST gets the 'does not work' page and no cookie", async () => {
    const port = await start();
    const path = newLinkPath();
    expect((await call(port, "POST", path)).status).toBe(303);
    const again = await call(port, "POST", path);
    expect(again.status).toBe(410);
    expect(again.headers["set-cookie"]).toBeUndefined();
    expect(again.body).toContain("works once");
    expect(devices.list()).toHaveLength(1);
  });

  it("an expired link is refused", async () => {
    const port = await start();
    const path = newLinkPath();
    clock = new Date(clock.getTime() + PAIRING_TTL_MS + 1_000);
    const out = await call(port, "POST", path);
    expect(out.status).toBe(410);
    expect(devices.list()).toEqual([]);
  });

  it("a token that is not one of ours is a 404 before the store is touched", async () => {
    const port = await start();
    expect((await call(port, "POST", "/pair/short")).status).toBe(404);
    expect((await call(port, "GET", "/pair/short")).status).toBe(404);
  });

  it("marks the cookie Secure behind an HTTPS tunnel", async () => {
    const port = await start();
    const out = await call(port, "POST", newLinkPath(), { "x-forwarded-proto": "https" });
    expect(([] as string[]).concat(out.headers["set-cookie"] ?? []).join(";")).toContain("Secure");
  });
});

describe("admin device routes", () => {
  const admin = { authorization: `Bearer ${KEY}` };

  it("POST /api/devices/pairing makes a link the phone can redeem", async () => {
    const port = await start();
    const made = await call(port, "POST", "/api/devices/pairing", admin);
    expect(made.status).toBe(201);
    const { path } = JSON.parse(made.body) as { path: string };
    expect(path).toMatch(/^\/pair\/[A-Za-z0-9_-]{43}$/);
    expect((await call(port, "POST", path)).status).toBe(303);
  });

  it("lists devices without hashes, and DELETE revokes", async () => {
    const port = await start();
    const secret = cookieFrom(await call(port, "POST", newLinkPath(), { "user-agent": IPHONE }));
    const listed = await call(port, "GET", "/api/devices", admin);
    const body = JSON.parse(listed.body) as { devices: Array<Record<string, unknown>> };
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).not.toHaveProperty("sha256");
    const id = String(body.devices[0]?.id);
    expect((await call(port, "DELETE", `/api/devices/${id}`, admin)).status).toBe(200);
    expect((await call(port, "GET", "/probe", { cookie: `${DEVICE_COOKIE}=${secret}` })).status).toBe(401);
    expect((await call(port, "DELETE", `/api/devices/${id}`, admin)).status).toBe(404);
  });

  it("a paired phone cannot list devices or make links", async () => {
    const port = await start();
    const secret = cookieFrom(await call(port, "POST", newLinkPath()));
    const phone = { cookie: `${DEVICE_COOKIE}=${secret}`, origin: `http://127.0.0.1:${port}` };
    expect((await call(port, "GET", "/api/devices", phone)).status).toBe(403);
    expect((await call(port, "POST", "/api/devices/pairing", phone)).status).toBe(403);
  });
});

describe("deviceNameFromUserAgent", () => {
  it("names the common phones", () => {
    expect(deviceNameFromUserAgent(IPHONE)).toBe("iPhone");
    expect(deviceNameFromUserAgent("Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari")).toBe("Android phone");
    expect(deviceNameFromUserAgent(null)).toBe("Browser");
  });
});
