/**
 * ATO-2493: whether phones on this Wi-Fi may reach the desktop's agent, and
 * where they find it. Settings › Connections › Connect phone's switch
 * "Allow phones on this Wi-Fi", modelled on LM Studio's "Serve on Local
 * Network": off by default, and while it is off `atag serve` listens on
 * 127.0.0.1 only, as it always has (serve-launch.ts).
 *
 * On, the agent is restarted on 0.0.0.0. Nothing is opened to the network
 * without a credential: every route still needs the per-launch key (48 hex
 * characters, never shown) or the cookie of a phone paired from this card
 * (src/http/device-auth.ts), and a paired phone is a member that cannot
 * change settings, save an Always allow rule or pick a folder.
 *
 * The port is fixed while it is on (PHONE_PORT), so the address a phone
 * saved to its home screen still works after the app restarts; when that
 * port is taken the agent takes a free one and the card shows the new
 * address. The setting lives beside serve.json in the desktop's state
 * directory, so a reset of that folder turns it off again.
 *
 * Node only (no electron), so agent-client.ts reads it at every spawn and
 * test/phone-access.test.mjs drives it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

import { DESKTOP_STATE_DIR } from "./state-dir.js";

/** The agent's port while phones may connect (19191 and 19192 are the desktop's model servers). */
export const PHONE_PORT = 19193;

export const LOOPBACK_HOST = "127.0.0.1";
export const ALL_INTERFACES_HOST = "0.0.0.0";

export function phoneAccessPath(stateDir: string = DESKTOP_STATE_DIR): string {
  return join(stateDir, "desktop-phone-access.json");
}

/** On only when the file says so; missing or broken is off. */
export function readPhoneAccess(path: string = phoneAccessPath()): boolean {
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

export function writePhoneAccess(enabled: boolean, path: string = phoneAccessPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ enabled })}\n`, { mode: 0o600 });
}

export function serveHostFor(enabled: boolean): string {
  return enabled ? ALL_INTERFACES_HOST : LOOPBACK_HOST;
}

/** Whether nothing listens on `port` on any interface right now. */
export function portFreeEverywhere(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, ALL_INTERFACES_HOST, () => srv.close(() => resolve(true)));
  });
}

/** PHONE_PORT while on and free; otherwise whatever `freePort` finds (the usual ephemeral port). */
export async function servePortFor(
  enabled: boolean,
  freePort: () => Promise<number>,
  isFree: (port: number) => Promise<boolean> = portFreeEverywhere,
): Promise<number> {
  if (enabled && (await isFree(PHONE_PORT))) return PHONE_PORT;
  return freePort();
}

type Interfaces = ReturnType<typeof networkInterfaces>;

/* Wi-Fi and wired adapters first (macOS en0, Linux wlan0/wlp/eth/enp, Windows "Wi-Fi"/"Ethernet"). */
const LIKELY_LAN = /^(en\d|wl|wi-?fi|wireless|eth|ethernet)/i;
/* VPNs, containers and virtual machines: a phone on the Wi-Fi does not reach these. */
const NOT_LAN = /^(utun|tun|tap|ppp|ipsec|awdl|llw|bridge|docker|br-|veth|vboxnet|vmnet|virbr|zt|tailscale|lo\d*$)/i;

/**
 * This computer's IPv4 addresses a phone on the same network can open,
 * the likeliest first. Link-local (169.254.x) and loopback are left out.
 */
export function lanAddresses(interfaces: Interfaces = networkInterfaces()): string[] {
  const likely: string[] = [];
  const other: string[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    if (NOT_LAN.test(name)) continue;
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      (LIKELY_LAN.test(name) ? likely : other).push(a.address);
    }
  }
  return [...new Set([...likely, ...other])];
}
