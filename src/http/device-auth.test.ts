import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEVICE_COOKIE, readCookie } from "./device-auth.js";
import { createDeviceSessions, type DeviceSessions } from "./device-sessions.js";
import { createHttpServer, type HttpServerHandle, type RouteDefinition } from "./http-server.js";
import { sendJson } from "./request-context.js";

/**
 * ATO-2308: a paired phone's cookie on a real server with stub routes.
 * It signs in as a member, never as admin, and only from the panel's own
 * origin for anything that changes state.
 */
const KEY = "k".repeat(32);
const ok = (_req: unknown, res: Parameters<RouteDefinition["handler"]>[1]): void => sendJson(res, 200, { ok: true });
const ROUTES: RouteDefinition[] = [
  { method: "GET", path: "/read", handler: ok, scope: "read" },
  { method: "POST", path: "/chat", handler: ok, scope: "chat" },
  { method: "POST", path: "/admin", handler: ok, scope: "admin" },
];

let dir: string;
let devices: DeviceSessions;
const servers: HttpServerHandle[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atag-device-auth-"));
  devices = createDeviceSessions(dir);
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  rmSync(dir, { recursive: true, force: true });
});

async function start(withDevices = true): Promise<number> {
  const handle = await createHttpServer({
    runtime: {} as never,
    host: "127.0.0.1",
    port: 0,
    apiKey: KEY,
    routes: ROUTES,
    ...(withDevices ? { deviceSessions: devices } : {}),
  });
  servers.push(handle);
  return handle.port;
}

interface Answer {
  status: number;
  code: string | null;
  setCookie: string[];
}

function call(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let code: string | null = null;
        try {
          code = (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? null;
        } catch {
          code = null;
        }
        resolve({ status: res.statusCode ?? 0, code, setCookie: res.headers["set-cookie"] ?? [] });
      });
    });
    req.on("error", reject);
    if (method !== "GET") {
      req.setHeader("content-type", "application/json");
      req.end("{}");
    } else req.end();
  });
}

function pairedSecret(): { id: string; secret: string } {
  const made = devices.createPairing();
  if (!made.ok) throw new Error(made.error);
  const redeemed = devices.redeem(made.token, "iPhone");
  if (!redeemed.ok) throw new Error(redeemed.error);
  return { id: redeemed.device.id, secret: redeemed.secret };
}

const cookie = (secret: string) => ({ cookie: `other=1; ${DEVICE_COOKIE}=${secret}` });

describe("device cookie auth", () => {
  it("signs a paired phone in for read and chat", async () => {
    const port = await start();
    const { secret } = pairedSecret();
    expect((await call(port, "GET", "/read", cookie(secret))).status).toBe(200);
    const origin = { origin: `http://127.0.0.1:${port}` };
    expect((await call(port, "POST", "/chat", { ...cookie(secret), ...origin })).status).toBe(200);
  });

  it("never lets a phone use an admin route", async () => {
    const port = await start();
    const { secret } = pairedSecret();
    const out = await call(port, "POST", "/admin", { ...cookie(secret), origin: `http://127.0.0.1:${port}` });
    expect(out).toMatchObject({ status: 403, code: "insufficient_scope" });
  });

  it("refuses a state change without the panel's own Origin", async () => {
    const port = await start();
    const { secret } = pairedSecret();
    expect(await call(port, "POST", "/chat", cookie(secret))).toMatchObject({ status: 403, code: "origin_not_allowed" });
    expect(await call(port, "POST", "/chat", { ...cookie(secret), origin: "https://evil.example" }))
      .toMatchObject({ status: 403, code: "origin_not_allowed" });
  });

  it("an unknown cookie is 401 and the browser is told to drop it", async () => {
    const port = await start();
    const out = await call(port, "GET", "/read", cookie("y".repeat(43)));
    expect(out).toMatchObject({ status: 401, code: "invalid_api_key" });
    expect(out.setCookie.join(";")).toContain(`${DEVICE_COOKIE}=;`);
  });

  it("revoke signs the phone out from the next request", async () => {
    const port = await start();
    const { id, secret } = pairedSecret();
    expect((await call(port, "GET", "/read", cookie(secret))).status).toBe(200);
    expect(devices.revoke(id)).toMatchObject({ ok: true });
    expect((await call(port, "GET", "/read", cookie(secret))).status).toBe(401);
  });

  it("leaves key auth as it was: the key still works, and a cookie never upgrades a wrong key", async () => {
    const port = await start();
    const { secret } = pairedSecret();
    expect((await call(port, "POST", "/admin", { authorization: `Bearer ${KEY}` })).status).toBe(200);
    expect((await call(port, "GET", "/read", { authorization: "Bearer wrong", ...cookie(secret) })).status).toBe(401);
  });

  it("a server without a device store ignores the cookie", async () => {
    const port = await start(false);
    const { secret } = pairedSecret();
    expect((await call(port, "GET", "/read", cookie(secret))).status).toBe(401);
  });
});

describe("readCookie", () => {
  it("finds one cookie among several and ignores a name that only ends the same", () => {
    const req = { headers: { cookie: `xatag_device=no; ${DEVICE_COOKIE}=yes; z=1` } } as never;
    expect(readCookie(req, DEVICE_COOKIE)).toBe("yes");
    expect(readCookie({ headers: {} } as never, DEVICE_COOKIE)).toBeNull();
  });
});
