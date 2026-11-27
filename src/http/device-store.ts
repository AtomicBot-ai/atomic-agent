import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeOwnerOnlyFileAtomicSync } from "../config/owner-only-file.js";
import { withFileLock } from "./device-file-lock.js";
import { secretEquals } from "./secret-equal.js";

/**
 * ATO-2308: `<stateDir>/http-devices.json`, the phones paired with
 * `atag serve` by a QR code (`atag pair`), and the pairing links not yet
 * used. Modelled on OpenCode's `pair` command (MIT): a link works once,
 * for a few minutes, and turns into a device session the panel signs in
 * with, so nobody types the API key on a phone.
 *
 * Only SHA-256 hashes are stored, of each link token and of each device's
 * session secret, the way `http-tokens.json` keeps named tokens. Both are
 * 256 random bits. The file is owner-only and every change goes through
 * `withFileLock`, because serve and `atag pair` both write it.
 */
export const HTTP_DEVICES_FILE = "http-devices.json";

/** A pairing link works this long, once (OpenCode and WhatsApp Web use minutes too). */
export const PAIRING_TTL_MS = 5 * 60_000;

/** Pending links kept at most; the oldest goes when a new one is made. */
const MAX_PENDING = 10;

export interface PendingPairing {
  sha256: string;
  createdAt: string;
  expiresAt: string;
}

export interface PairedDevice {
  /** Short id for `atag pair --revoke <id>`. */
  id: string;
  /** "iPhone", "Android phone", from the browser that paired. */
  name: string;
  /** Hex SHA-256 of the device's session secret (the cookie). */
  sha256: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface DevicesData {
  pairings: PendingPairing[];
  devices: PairedDevice[];
}

export type DevicesRead = { ok: true; data: DevicesData } | { ok: false; error: string };

export function httpDevicesPath(stateDir: string): string {
  return join(stateDir, HTTP_DEVICES_FILE);
}

export function hashDeviceSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

const HEX64 = /^[0-9a-f]{64}$/;

function isPending(raw: unknown): raw is PendingPairing {
  const r = raw as Record<string, unknown> | null;
  return typeof r === "object" && r !== null && typeof r.sha256 === "string" && HEX64.test(r.sha256)
    && typeof r.expiresAt === "string" && typeof r.createdAt === "string";
}

function isDevice(raw: unknown): raw is PairedDevice {
  const r = raw as Record<string, unknown> | null;
  return typeof r === "object" && r !== null && typeof r.id === "string" && typeof r.name === "string"
    && typeof r.sha256 === "string" && HEX64.test(r.sha256)
    && typeof r.createdAt === "string" && typeof r.lastSeenAt === "string";
}

/** The file as it is now. Missing is empty; broken is an error (and signs no device in). */
export function readDevices(stateDir: string): DevicesRead {
  let text: string;
  try {
    text = readFileSync(httpDevicesPath(stateDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, data: { pairings: [], devices: [] } };
    return { ok: false, error: `cannot read ${HTTP_DEVICES_FILE}: ${(err as Error).message}` };
  }
  let parsed: { pairings?: unknown; devices?: unknown } | null;
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return { ok: false, error: `${HTTP_DEVICES_FILE} is not valid JSON` };
  }
  const pairings = parsed?.pairings ?? [];
  const devices = parsed?.devices ?? [];
  if (!Array.isArray(pairings) || !pairings.every(isPending)) {
    return { ok: false, error: `${HTTP_DEVICES_FILE} has a pairing entry that is not valid` };
  }
  if (!Array.isArray(devices) || !devices.every(isDevice)) {
    return { ok: false, error: `${HTTP_DEVICES_FILE} has a device entry that is not valid` };
  }
  return { ok: true, data: { pairings, devices } };
}

interface StoreError {
  ok: false;
  error: string;
  reason: "store";
}

/** Read, change and write the file under the lock. `change` returns what the caller gets back. */
function mutate<T>(stateDir: string, change: (data: DevicesData) => T): T | StoreError {
  mkdirSync(stateDir, { recursive: true });
  const path = httpDevicesPath(stateDir);
  return withFileLock(path, () => {
    const current = readDevices(stateDir);
    if (!current.ok) return { ok: false, error: current.error, reason: "store" } satisfies StoreError;
    const result = change(current.data);
    writeOwnerOnlyFileAtomicSync(path, `${JSON.stringify({ version: 1, ...current.data }, null, 2)}\n`);
    return result;
  });
}

function unexpired(pairings: PendingPairing[], now: Date): PendingPairing[] {
  return pairings.filter((p) => Date.parse(p.expiresAt) > now.getTime());
}

export type CreatePairingResult = { ok: true; token: string; expiresAt: string } | { ok: false; error: string };

/** A new one-time link token. The token itself exists only in the return value. */
export function createPairing(
  stateDir: string,
  now: Date = new Date(),
  ttlMs: number = PAIRING_TTL_MS,
): CreatePairingResult {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  return mutate(stateDir, (data) => {
    const kept = unexpired(data.pairings, now).slice(-(MAX_PENDING - 1));
    data.pairings = [...kept, { sha256: hashDeviceSecret(token), createdAt: now.toISOString(), expiresAt }];
    return { ok: true as const, token, expiresAt };
  });
}

export type RedeemPairingResult =
  | { ok: true; secret: string; device: PairedDevice }
  | { ok: false; error: string; reason: "unknown" | "expired" | "store" };

/**
 * Trade a link token for a new device and its session secret. The link
 * is removed whether it was still good or had expired, so it never works
 * twice. Every pending hash is compared in constant time with no early exit.
 */
export function redeemPairing(
  stateDir: string,
  token: string,
  deviceName: string,
  now: Date = new Date(),
): RedeemPairingResult {
  const hash = hashDeviceSecret(token);
  return mutate(stateDir, (data): RedeemPairingResult => {
    let found: PendingPairing | null = null;
    for (const p of data.pairings) {
      if (secretEquals(hash, p.sha256) && found === null) found = p;
    }
    data.pairings = unexpired(data.pairings.filter((p) => p !== found), now);
    if (!found) return { ok: false, error: "This pairing link is not valid or was already used.", reason: "unknown" };
    if (Date.parse(found.expiresAt) <= now.getTime()) {
      return { ok: false, error: "This pairing link has expired.", reason: "expired" };
    }
    const secret = randomBytes(32).toString("base64url");
    const at = now.toISOString();
    const device: PairedDevice = {
      id: newDeviceId(data.devices),
      name: deviceName,
      sha256: hashDeviceSecret(secret),
      createdAt: at,
      lastSeenAt: at,
    };
    data.devices = [...data.devices, device];
    return { ok: true, secret, device };
  });
}

function newDeviceId(devices: readonly PairedDevice[]): string {
  for (;;) {
    const id = randomBytes(4).toString("hex");
    if (!devices.some((d) => d.id === id)) return id;
  }
}

export type RevokeDeviceResult = { ok: true; removed: PairedDevice[] } | { ok: false; error: string };

/** Sign out one device (`id`) or every one (`"all"`); serve refuses its cookie from the next request. */
export function revokeDevice(stateDir: string, id: string): RevokeDeviceResult {
  return mutate(stateDir, (data): RevokeDeviceResult => {
    const removed = id === "all" ? data.devices : data.devices.filter((d) => d.id === id);
    if (removed.length === 0) return { ok: false, error: `no paired device with id "${id}"` };
    data.devices = data.devices.filter((d) => !removed.includes(d));
    if (id === "all") data.pairings = [];
    return { ok: true, removed };
  });
}

/** Record when a device was last seen. A revoked device stays revoked: an unknown id is a no-op. */
export function touchDevice(stateDir: string, id: string, at: Date = new Date()): void {
  mutate(stateDir, (data) => {
    const device = data.devices.find((d) => d.id === id);
    if (device) device.lastSeenAt = at.toISOString();
    return null;
  });
}
