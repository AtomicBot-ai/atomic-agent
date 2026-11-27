import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isLocalRequest, throttleAddress } from "./auth-throttle.js";
import { DEVICE_COOKIE } from "./device-auth.js";
import { createDeviceSessions, type DeviceSessions } from "./device-sessions.js";
import { createHttpServer, type HttpServerHandle, type RouteDefinition } from "./http-server.js";
import { sendJson } from "./request-context.js";

/**
 * ATO-2308 review: `atag pair --remote` fronts serve's loopback port with
 * cloudflared, so every internet caller arrives from 127.0.0.1. Wrong keys
 * must still be counted, by the `cf-connecting-ip` cloudflared adds.
 * The server's throttle is shared by every server in the process, so each
 * test uses its own documentation address (RFC 5737).
 */
const KEY = "k".repeat(32);
const ROUTES: RouteDefinition[] = [
  { method: "GET", path: "/read", handler: (_req, res) => sendJson(res, 200, { ok: true }), scope: "read" },
];

const servers: HttpServerHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(withDevices = false): Promise<number> {
  let deviceSessions: DeviceSessions | undefined;
  if (withDevices) {
    const dir = mkdtempSync(join(tmpdir(), "atag-throttle-tunnel-"));
    dirs.push(dir);
    deviceSessions = createDeviceSessions(dir);
  }
  const handle = await createHttpServer({
    runtime: {} as never,
    host: "127.0.0.1",
    port: 0,
    apiKey: KEY,
    routes: ROUTES,
    ...(deviceSessions ? { deviceSessions } : {}),
  });
  servers.push(handle);
  return handle.port;
}

function status(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "GET", path: "/read", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

async function statuses(port: number, headers: Record<string, string>, n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(await status(port, headers));
  return out;
}

describe("auth throttle behind the --remote tunnel", () => {
  it("counts wrong keys by cf-connecting-ip on a loopback socket and locks that caller out", async () => {
    const port = await start();
    const wrong = { authorization: "Bearer wrong", "cf-connecting-ip": "203.0.113.41" };
    const seen = await statuses(port, wrong, 11);
    expect(seen.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(seen[10]).toBe(429);
    // Even the right key waits while that caller is blocked.
    expect(await status(port, { authorization: `Bearer ${KEY}`, "cf-connecting-ip": "203.0.113.41" })).toBe(429);
    // Another caller through the same tunnel is not blocked.
    expect(await status(port, { authorization: `Bearer ${KEY}`, "cf-connecting-ip": "203.0.113.42" })).toBe(200);
  });

  it("still never counts a plain loopback caller (the desktop app, local scripts)", async () => {
    const port = await start();
    const seen = await statuses(port, { authorization: "Bearer wrong" }, 15);
    expect(seen).toEqual(Array(15).fill(401));
    expect(await status(port, { authorization: `Bearer ${KEY}` })).toBe(200);
  });

  it("counts wrong device cookies through the tunnel the same way", async () => {
    const port = await start(true);
    const wrong = { cookie: `${DEVICE_COOKIE}=${"y".repeat(43)}`, "cf-connecting-ip": "203.0.113.43" };
    const seen = await statuses(port, wrong, 11);
    expect(seen.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(seen[10]).toBe(429);
  });
});

describe("throttleAddress", () => {
  const req = (remoteAddress: string | undefined, headers: Record<string, string | string[]> = {}) =>
    ({ socket: { remoteAddress }, headers }) as never;

  it("uses cf-connecting-ip only on a loopback socket, trimmed, one value", () => {
    expect(throttleAddress(req("127.0.0.1", { "cf-connecting-ip": " 198.51.100.7 " }))).toBe("198.51.100.7");
    expect(throttleAddress(req("::ffff:127.0.0.1", { "cf-connecting-ip": "198.51.100.7, 10.0.0.1" }))).toBe("198.51.100.7");
    expect(throttleAddress(req("::1", { "cf-connecting-ip": ["2001:db8::5", "198.51.100.8"] }))).toBe("2001:db8::5");
  });

  it("ignores the header from a non-loopback socket, so a remote caller cannot choose its own address", () => {
    expect(throttleAddress(req("192.168.1.30", { "cf-connecting-ip": "198.51.100.7" }))).toBe("192.168.1.30");
    expect(throttleAddress(req("192.168.1.30", { "cf-connecting-ip": "127.0.0.1" }))).toBe("192.168.1.30");
  });

  it("falls back to the socket address without a usable header", () => {
    expect(throttleAddress(req("127.0.0.1"))).toBe("127.0.0.1");
    expect(throttleAddress(req("127.0.0.1", { "cf-connecting-ip": "  " }))).toBe("127.0.0.1");
    expect(throttleAddress(req("127.0.0.1", { "cf-connecting-ip": "x".repeat(65) }))).toBe("127.0.0.1");
    expect(throttleAddress(req(undefined))).toBeUndefined();
  });
});

describe("isLocalRequest", () => {
  const req = (remoteAddress: string | undefined, headers: Record<string, string> = {}) =>
    ({ socket: { remoteAddress }, headers }) as never;

  it("is true only for a loopback socket without cf-connecting-ip", () => {
    expect(isLocalRequest(req("127.0.0.1"))).toBe(true);
    expect(isLocalRequest(req("::ffff:127.0.0.1"))).toBe(true);
    expect(isLocalRequest(req("::1"))).toBe(true);
    expect(isLocalRequest(req("127.0.0.1", { "cf-connecting-ip": "203.0.113.7" }))).toBe(false);
    expect(isLocalRequest(req("127.0.0.1", { "cf-connecting-ip": "" }))).toBe(false);
    expect(isLocalRequest(req("192.168.1.30"))).toBe(false);
    expect(isLocalRequest(req(undefined))).toBe(false);
  });
});
