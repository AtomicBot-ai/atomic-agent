import { statSync } from "node:fs";

import { MAX_CODE_FAILURES, MAX_CODE_FAILURES_PER_ADDRESS, normalizePairingCode } from "./device-code.js";
import {
  createPairing,
  hashDeviceSecret,
  httpDevicesPath,
  isDeviceIdle,
  readDevices,
  redeemPairing,
  redeemPairingCode,
  revokeDevice,
  touchDevice,
  type CreatePairingResult,
  type PairedDevice,
  type RedeemPairingResult,
  type RevokeDeviceResult,
} from "./device-store.js";
import { secretEquals } from "./secret-equal.js";

/**
 * ATO-2308: what serve needs from the paired-device store. `identify`
 * runs on every cookie-signed request, so the file is re-read only when
 * it changes (like `createHttpTokenSource`): `atag pair --revoke` in
 * another terminal applies from the next request, without a restart.
 */
export interface DeviceSessions {
  /**
   * The device whose session secret this is, or `null`. Records it as seen.
   * ATO-2494: a device idle longer than DEVICE_IDLE_MS is `null` too.
   */
  identify(secret: string): PairedDevice | null;
  redeem(token: string, deviceName: string): RedeemPairingResult;
  /**
   * ATO-2494: redeem by the short code typed on `/panel/pair`. After
   * MAX_CODE_FAILURES wrong codes (all callers together) every code is
   * refused (`reason: "locked"`) until `createPairing` makes a new one.
   * One `address` (throttleAddress) may spend only
   * MAX_CODE_FAILURES_PER_ADDRESS of them, so a single neighbour cannot
   * use up the whole budget. Input that cannot be a code is not counted.
   */
  redeemCode(typed: string, deviceName: string, address?: string): RedeemCodeResult;
  createPairing(): CreatePairingResult;
  list(): PairedDevice[];
  revoke(id: string): RevokeDeviceResult;
}

export type RedeemCodeResult = RedeemPairingResult | { ok: false; error: string; reason: "locked" };

/** `lastSeenAt` is written at most this often per device, not on every request. */
const TOUCH_EVERY_MS = 60_000;

export interface DeviceSessionsOptions {
  now?: () => Date;
}

export function createDeviceSessions(stateDir: string, options: DeviceSessionsOptions = {}): DeviceSessions {
  const now = options.now ?? (() => new Date());
  const path = httpDevicesPath(stateDir);
  let stamp = "";
  let cached: readonly PairedDevice[] = [];
  const lastTouch = new Map<string, number>();
  // Wrong codes since the newest pairing was made; `atag pair` in another process makes them too.
  let codeFailures = 0;
  // Per caller address, same epoch; at most MAX_CODE_FAILURES entries, since only failures add one.
  const failuresByAddress = new Map<string, number>();
  let codeEpoch = "";
  const newestPairing = (): string => {
    const read = readDevices(stateDir);
    if (!read.ok) return codeEpoch;
    return read.data.pairings.reduce((top, p) => (p.createdAt > top ? p.createdAt : top), "");
  };

  const devices = (): readonly PairedDevice[] => {
    let next: string;
    try {
      const st = statSync(path);
      next = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      stamp = "";
      cached = [];
      return cached;
    }
    if (next !== stamp) {
      const read = readDevices(stateDir);
      // A broken file signs nobody in; the serve key still works.
      cached = read.ok ? read.data.devices : [];
      stamp = next;
    }
    return cached;
  };

  const touch = (device: PairedDevice): void => {
    const at = now();
    const last = lastTouch.get(device.id) ?? Date.parse(device.lastSeenAt);
    if (Number.isFinite(last) && at.getTime() - last < TOUCH_EVERY_MS) return;
    lastTouch.set(device.id, at.getTime());
    try {
      touchDevice(stateDir, device.id, at);
    } catch {
      // Last seen is a hint for the device list; never fail a request over it.
    }
  };

  return {
    identify(secret) {
      if (secret.length === 0) return null;
      const hash = hashDeviceSecret(secret);
      let found: PairedDevice | null = null;
      for (const device of devices()) {
        if (secretEquals(hash, device.sha256) && found === null) found = device;
      }
      if (!found) return null;
      // Seen more recently than the file says when the last write was skipped or failed.
      const touched = lastTouch.get(found.id);
      const seen = touched !== undefined ? new Date(Math.max(touched, Date.parse(found.lastSeenAt) || 0)).toISOString() : found.lastSeenAt;
      if (isDeviceIdle({ lastSeenAt: seen }, now())) return null;
      touch(found);
      return found;
    },
    redeem: (token, deviceName) => redeemPairing(stateDir, token, deviceName, now()),
    redeemCode(typed, deviceName, address) {
      const epoch = newestPairing();
      if (epoch !== codeEpoch) {
        codeEpoch = epoch;
        codeFailures = 0;
        failuresByAddress.clear();
      }
      const caller = address ?? "";
      const byCaller = failuresByAddress.get(caller) ?? 0;
      if (codeFailures >= MAX_CODE_FAILURES || byCaller >= MAX_CODE_FAILURES_PER_ADDRESS) {
        return { ok: false, error: "Too many wrong codes. Make a new code on the computer.", reason: "locked" };
      }
      const code = normalizePairingCode(typed);
      // Not a code at all: no guess was made, so it spends nothing.
      if (code === null) return { ok: false, error: "This code is not valid or was already used.", reason: "unknown" };
      const result = redeemPairingCode(stateDir, code, deviceName, now());
      if (!result.ok && result.reason !== "store") {
        codeFailures++;
        failuresByAddress.set(caller, byCaller + 1);
      }
      return result;
    },
    createPairing: () => createPairing(stateDir, now()),
    list: () => {
      const read = readDevices(stateDir);
      const at = now();
      return read.ok ? read.data.devices.filter((d) => !isDeviceIdle(d, at)) : [];
    },
    revoke: (id) => revokeDevice(stateDir, id),
  };
}
