import { statSync } from "node:fs";

import {
  createPairing,
  hashDeviceSecret,
  httpDevicesPath,
  readDevices,
  redeemPairing,
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
  /** The device whose session secret this is, or `null`. Records it as seen. */
  identify(secret: string): PairedDevice | null;
  redeem(token: string, deviceName: string): RedeemPairingResult;
  createPairing(): CreatePairingResult;
  list(): PairedDevice[];
  revoke(id: string): RevokeDeviceResult;
}

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
      if (found) touch(found);
      return found;
    },
    redeem: (token, deviceName) => redeemPairing(stateDir, token, deviceName, now()),
    createPairing: () => createPairing(stateDir, now()),
    list: () => {
      const read = readDevices(stateDir);
      return read.ok ? read.data.devices : [];
    },
    revoke: (id) => revokeDevice(stateDir, id),
  };
}
