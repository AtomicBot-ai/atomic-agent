import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CODE_ALPHABET, formatPairingCode, normalizePairingCode } from "./device-code.js";
import {
  createPairing,
  DEVICE_IDLE_MS,
  httpDevicesPath,
  isDeviceIdle,
  readDevices,
  redeemPairing,
  redeemPairingCode,
} from "./device-store.js";

/** ATO-2494: the short pairing code beside the QR link, and the 30-day idle sign-out. */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atag-device-code-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const T0 = new Date("2026-11-27T10:00:00.000Z");
const later = (ms: number): Date => new Date(T0.getTime() + ms);

function made(at: Date = T0): { token: string; code: string } {
  const result = createPairing(dir, at);
  if (!result.ok) throw new Error(result.error);
  return { token: result.token, code: result.code };
}

describe("pairing codes", () => {
  it("are 8 letters from the consonant alphabet, shown with a dash", () => {
    const { code } = made();
    expect(code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{8}$`));
    expect(formatPairingCode(code)).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
  });

  it("normalize ignores case, spaces and dashes, and refuses anything that cannot be a code", () => {
    expect(normalizePairingCode(" bcdf-ghjk ")).toBe("BCDFGHJK");
    expect(normalizePairingCode("BCDF GHJK")).toBe("BCDFGHJK");
    expect(normalizePairingCode("BCDF-GHJ")).toBeNull();
    // A vowel or a digit is outside the alphabet.
    expect(normalizePairingCode("ABCD-FGHJ")).toBeNull();
    expect(normalizePairingCode("BCD0-FGHJ")).toBeNull();
  });

  it("a code redeems once, and spends the link of the same pairing", () => {
    const { token, code } = made();
    const first = redeemPairingCode(dir, code, "iPhone", later(1_000));
    expect(first.ok).toBe(true);
    expect(redeemPairingCode(dir, code, "iPhone", later(2_000))).toMatchObject({ ok: false, reason: "unknown" });
    expect(redeemPairing(dir, token, "iPhone", later(3_000))).toMatchObject({ ok: false, reason: "unknown" });
  });

  it("using the link spends the code", () => {
    const { token, code } = made();
    expect(redeemPairing(dir, token, "iPhone", later(1_000)).ok).toBe(true);
    expect(redeemPairingCode(dir, code, "iPhone", later(2_000))).toMatchObject({ ok: false, reason: "unknown" });
  });

  it("only the code's hash is on disk", () => {
    const { code } = made();
    expect(readFileSync(httpDevicesPath(dir), "utf8")).not.toContain(code);
  });

  it("a pending link from before codes existed still reads and redeems by link, never by an empty code", () => {
    const { token } = made();
    const data = JSON.parse(readFileSync(httpDevicesPath(dir), "utf8")) as { pairings: Array<Record<string, unknown>> };
    for (const p of data.pairings) delete p.codeSha256;
    writeFileSync(httpDevicesPath(dir), JSON.stringify(data));
    expect(readDevices(dir).ok).toBe(true);
    expect(redeemPairingCode(dir, "BCDFGHJK", "iPhone", later(1))).toMatchObject({ ok: false, reason: "unknown" });
    expect(redeemPairing(dir, token, "iPhone", later(2)).ok).toBe(true);
  });
});

describe("idle devices", () => {
  it("count as idle only past 30 days without use", () => {
    expect(isDeviceIdle({ lastSeenAt: T0.toISOString() }, later(DEVICE_IDLE_MS - 1))).toBe(false);
    expect(isDeviceIdle({ lastSeenAt: T0.toISOString() }, later(DEVICE_IDLE_MS + 1))).toBe(true);
    expect(isDeviceIdle({ lastSeenAt: "not a date" }, T0)).toBe(true);
  });

  it("are dropped from the file the next time a pairing is made", () => {
    const { token } = made();
    expect(redeemPairing(dir, token, "iPhone", later(1)).ok).toBe(true);
    made(later(DEVICE_IDLE_MS + 60_000));
    const read = readDevices(dir);
    expect(read.ok && read.data.devices).toEqual([]);
  });
});
