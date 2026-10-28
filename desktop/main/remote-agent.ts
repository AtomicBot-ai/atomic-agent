/**
 * ATO-1127 (also ATO-597, ATO-1068) — connect the app to an agent on another
 * computer or a VPS instead of starting its own `atag serve`.
 *
 * The address and the agent's API key live in userData/remote-agent.json;
 * the key is encrypted with the system keychain (Electron safeStorage) where
 * the system offers it, and is not saved at all where it does not (the
 * person types it again after a restart). No address saved: the app runs its
 * own agent, as before.
 *
 * Pure apart from the file; the encryption is handed in.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RemoteAgent {
  url: string;
  token: string;
}

export interface KeyBox {
  available(): boolean;
  seal(plain: string): string;
  open(sealed: string): string;
}

const FILE = "remote-agent.json";

/** A plain `http(s)://host[:port]` with no path, query or credentials, or null. */
export function cleanRemoteUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== "/" && u.pathname !== "") return null;
  return `${u.protocol}//${u.host}`;
}

export function readRemoteAgent(userData: string, box: KeyBox): RemoteAgent | null {
  try {
    const raw = JSON.parse(readFileSync(join(userData, FILE), "utf8")) as { url?: unknown; sealedToken?: unknown };
    const url = typeof raw.url === "string" ? cleanRemoteUrl(raw.url) : null;
    if (!url || typeof raw.sealedToken !== "string" || !box.available()) return null;
    const token = box.open(raw.sealedToken);
    return token ? { url, token } : null;
  } catch {
    return null;
  }
}

/** Saves the address and the sealed key; answers false when the system cannot keep a key safely (then nothing is saved). */
export function writeRemoteAgent(userData: string, box: KeyBox, remote: RemoteAgent | null): boolean {
  const file = join(userData, FILE);
  if (!remote) {
    rmSync(file, { force: true });
    return true;
  }
  if (!box.available()) return false;
  writeFileSync(file, `${JSON.stringify({ url: remote.url, sealedToken: box.seal(remote.token) })}\n`, { mode: 0o600 });
  return true;
}
