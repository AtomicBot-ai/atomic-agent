import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createPairing,
  httpDevicesPath,
  PAIRING_TTL_MS,
  readDevices,
  redeemPairing,
  revokeDevice,
  touchDevice,
} from "./device-store.js";

/** ATO-2308: one-time pairing links and the paired-device list. */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atag-devices-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const T0 = new Date("2026-11-27T10:00:00.000Z");
const later = (ms: number): Date => new Date(T0.getTime() + ms);

function newToken(): string {
  const made = createPairing(dir, T0);
  if (!made.ok) throw new Error(made.error);
  return made.token;
}

describe("pairing links", () => {
  it("a link token turns into a device once, and the second try is refused", () => {
    const token = newToken();
    const first = redeemPairing(dir, token, "iPhone", later(1_000));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.device.name).toBe("iPhone");
    expect(first.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const again = redeemPairing(dir, token, "iPhone", later(2_000));
    expect(again).toMatchObject({ ok: false, reason: "unknown" });
    const read = readDevices(dir);
    expect(read.ok && read.data.devices.length).toBe(1);
  });

  it("an expired link is refused and removed", () => {
    const token = newToken();
    expect(redeemPairing(dir, token, "iPhone", later(PAIRING_TTL_MS + 1))).toMatchObject({ ok: false, reason: "expired" });
    // Gone now, so the same token is unknown, not "expired", afterwards.
    expect(redeemPairing(dir, token, "iPhone", later(PAIRING_TTL_MS + 2))).toMatchObject({ ok: false, reason: "unknown" });
    const read = readDevices(dir);
    expect(read.ok && read.data.devices).toEqual([]);
  });

  it("a made-up token is refused and adds no device", () => {
    newToken();
    expect(redeemPairing(dir, "x".repeat(43), "iPhone", later(1))).toMatchObject({ ok: false, reason: "unknown" });
    const read = readDevices(dir);
    expect(read.ok && read.data.devices).toEqual([]);
  });

  it("stores hashes only: neither the link token nor the session secret is on disk", () => {
    const token = newToken();
    const redeemed = redeemPairing(dir, token, "iPhone", later(1));
    if (!redeemed.ok) throw new Error("redeem failed");
    const second = newToken();
    const text = readFileSync(httpDevicesPath(dir), "utf8");
    expect(text).not.toContain(token);
    expect(text).not.toContain(second);
    expect(text).not.toContain(redeemed.secret);
    if (process.platform !== "win32") expect(statSync(httpDevicesPath(dir)).mode & 0o777).toBe(0o600);
  });

  it("keeps at most 10 pending links", () => {
    for (let i = 0; i < 15; i++) newToken();
    const read = readDevices(dir);
    expect(read.ok && read.data.pairings.length).toBe(10);
  });
});

describe("devices", () => {
  function pairOne(name = "iPhone"): string {
    const r = redeemPairing(dir, newToken(), name, later(1));
    if (!r.ok) throw new Error("redeem failed");
    return r.device.id;
  }

  it("revoke removes one device by id; an unknown id is an error", () => {
    const a = pairOne("iPhone");
    const b = pairOne("Android phone");
    expect(revokeDevice(dir, a)).toMatchObject({ ok: true });
    const read = readDevices(dir);
    expect(read.ok && read.data.devices.map((d) => d.id)).toEqual([b]);
    expect(revokeDevice(dir, a)).toMatchObject({ ok: false });
  });

  it("revoke all signs every device out and drops pending links", () => {
    pairOne();
    pairOne();
    newToken();
    expect(revokeDevice(dir, "all")).toMatchObject({ ok: true });
    const read = readDevices(dir);
    expect(read.ok && read.data).toEqual({ pairings: [], devices: [] });
  });

  it("touch updates last seen, and never brings a revoked device back", () => {
    const id = pairOne();
    touchDevice(dir, id, later(60_000));
    let read = readDevices(dir);
    expect(read.ok && read.data.devices[0]?.lastSeenAt).toBe(later(60_000).toISOString());
    revokeDevice(dir, id);
    touchDevice(dir, id, later(120_000));
    read = readDevices(dir);
    expect(read.ok && read.data.devices).toEqual([]);
  });

  it("a broken file is an error, and redeeming against it changes nothing", () => {
    writeFileSync(httpDevicesPath(dir), "{not json");
    expect(readDevices(dir).ok).toBe(false);
    expect(redeemPairing(dir, "x".repeat(43), "iPhone", T0)).toMatchObject({ ok: false, reason: "store" });
    expect(readFileSync(httpDevicesPath(dir), "utf8")).toBe("{not json");
  });
});
