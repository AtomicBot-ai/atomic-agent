import { resolveStateDir } from "../config/index.js";
import { createPairing, PAIRING_TTL_MS, readDevices, revokeDevice } from "../http/device-store.js";
import { formatDeviceLine } from "./pair-list-format.js";
import { openRemoteTunnel, REMOTE_WARNING, type RemoteTunnelDeps } from "./pair-remote.js";
import { resolvePairTarget } from "./pair-target.js";
import { isAlive } from "./serve-orphan-guard.js";
import { readServeRecords, type ServeRecord } from "./serve-reaper.js";

/**
 * ATO-2308: `atag pair`, connect a phone to the panel by a QR code. The
 * code holds a one-time link (5 minutes); the phone opens it, taps
 * Connect, and gets a device session (a cookie) with the member role, so
 * no API key is typed on the phone. Modelled on OpenCode's `pair`
 * command (MIT): one-time links, a QR in the terminal, `--remote` for a
 * tunnel behind a warning. `--list` and `--revoke` manage the devices.
 */
export const PAIR_HELP = [
  "Usage: atomic-agent pair [--remote | --url <address>]",
  "       atomic-agent pair --list",
  "       atomic-agent pair --revoke <id|all>",
  "",
  "Show a QR code that connects a phone to the panel of the running atag serve, without",
  "typing the API key. The link in it works once, for 5 minutes. A paired phone can chat and",
  "answer the agent's questions and approvals one at a time. It cannot change settings, save",
  "an Always allow rule, or move a chat to another folder.",
  "",
  "  (no option)        Same Wi-Fi: needs atag serve --host 0.0.0.0",
  "  --remote           Through a Cloudflare quick tunnel (needs cloudflared); stays open until Ctrl+C",
  "  --url <address>    Put this address in the code instead (a VPN name, your own proxy)",
  "  --list             Paired devices: id, name, when paired, last seen",
  "  --revoke <id|all>  Sign a device out (all: every one); it needs a new code to come back",
  "",
  "Devices live in <stateDir>/http-devices.json (owner-only, hashes only).",
].join("\n");

type Parsed =
  | { mode: "help" }
  | { mode: "list" }
  | { mode: "revoke"; id: string }
  | { mode: "pair"; remote: boolean; url: string | null }
  | { error: string };

export function parsePairArgs(args: readonly string[]): Parsed {
  let remote = false;
  let url: string | null = null;
  let list = false;
  let revoke: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "-h" || arg === "--help") return { mode: "help" };
    if (arg === "--remote") remote = true;
    else if (arg === "--list") list = true;
    else if (arg === "--url" || arg === "--revoke") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) return { error: `${arg} needs a value` };
      if (arg === "--url") url = value;
      else revoke = value;
      i++;
    } else return { error: `unknown argument ${arg}` };
  }
  const modes = [list, revoke !== null, remote || url !== null].filter(Boolean).length;
  if (modes > 1) return { error: "use one of --list, --revoke, or pairing options" };
  if (list) return { mode: "list" };
  if (revoke !== null) return { mode: "revoke", id: revoke };
  return { mode: "pair", remote, url };
}

export interface PairCommandDeps {
  write?: (text: string) => void;
  writeErr?: (text: string) => void;
  stateDir?: () => string;
  serveRecords?: (stateDir: string) => readonly ServeRecord[];
  isAlive?: (pid: number) => boolean;
  lanUrls?: (host: string, port: number) => string[];
  renderQr?: (text: string) => Promise<string>;
  tunnel?: RemoteTunnelDeps;
  /** Resolves when the person presses Ctrl+C (closes the `--remote` tunnel). */
  waitForStop?: () => Promise<void>;
  /** The clock for `--list` ages (ATO-2758). */
  now?: () => Date;
}

async function renderTerminalQr(text: string): Promise<string> {
  const loaded = (await import("qrcode-terminal")) as unknown as
    | { generate: (t: string, o: { small: boolean }, cb: (out: string) => void) => void }
    | { default: { generate: (t: string, o: { small: boolean }, cb: (out: string) => void) => void } };
  const qr = "default" in loaded ? loaded.default : loaded;
  return await new Promise<string>((resolve) => qr.generate(text, { small: true }, (out) => resolve(out)));
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

export async function pairCommand(args: string[], deps: PairCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const writeErr = deps.writeErr ?? ((t: string) => { process.stderr.write(t); });
  const parsed = parsePairArgs(args);
  if ("error" in parsed) {
    writeErr(`pair: ${parsed.error}\n\n${PAIR_HELP}\n`);
    return 2;
  }
  if (parsed.mode === "help") {
    write(`${PAIR_HELP}\n`);
    return 0;
  }
  const stateDir = (deps.stateDir ?? resolveStateDir)();

  if (parsed.mode === "list") {
    const read = readDevices(stateDir);
    if (!read.ok) {
      writeErr(`pair: ${read.error}\n`);
      return 1;
    }
    if (read.data.devices.length === 0) {
      write("No paired devices. Pair a phone with: atag pair\n");
      return 0;
    }
    const now = (deps.now ?? (() => new Date()))();
    for (const d of read.data.devices) write(`${formatDeviceLine(d, now)}\n`);
    return 0;
  }

  if (parsed.mode === "revoke") {
    const result = revokeDevice(stateDir, parsed.id);
    if (!result.ok) {
      writeErr(`pair: ${result.error}\n`);
      return 1;
    }
    const names = result.removed.map((d) => `${d.name} (${d.id})`).join(", ");
    write(`Signed out: ${names}. It needs a new code to connect again.\n`);
    return 0;
  }

  const target = resolvePairTarget({
    records: (deps.serveRecords ?? ((dir: string) => readServeRecords(dir).map((r) => r.record)))(stateDir),
    remote: parsed.remote,
    url: parsed.url,
    isAlive: deps.isAlive ?? isAlive,
    ...(deps.lanUrls ? { lanUrls: deps.lanUrls } : {}),
  });
  if (!target.ok) {
    writeErr(`pair: ${target.error}\n`);
    return 1;
  }

  let baseUrl: string;
  let stopTunnel: (() => Promise<void>) | null = null;
  if (target.kind === "remote") {
    // The warning is printed before anything is opened.
    writeErr(REMOTE_WARNING);
    writeErr("Starting cloudflared...\n");
    const tunnel = await openRemoteTunnel(target.originUrl, deps.tunnel);
    if (!tunnel.ok) {
      writeErr(`pair: ${tunnel.error}\n`);
      return 1;
    }
    baseUrl = tunnel.publicUrl;
    stopTunnel = tunnel.stop;
  } else {
    baseUrl = target.baseUrl;
  }

  try {
    const pairing = createPairing(stateDir);
    if (!pairing.ok) {
      writeErr(`pair: ${pairing.error}\n`);
      return 1;
    }
    const link = `${baseUrl}/pair/${pairing.token}`;
    write(`${await (deps.renderQr ?? renderTerminalQr)(link)}\n`);
    write(`Scan this with your phone's camera, or open: ${link}\n`);
    write(`The link works once, for ${Math.round(PAIRING_TTL_MS / 60_000)} minutes. See devices with: atag pair --list\n`);
    if (target.kind === "lan" && target.others.length > 0) {
      write(`If the phone cannot open it, this computer also answers at: ${target.others.join(", ")} (atag pair --url <address>)\n`);
    }
    if (!stopTunnel) return 0;
    write(`Tunnel open at ${baseUrl}. Keep this running while you use the phone; Ctrl+C closes it.\n`);
    await (deps.waitForStop ?? waitForSignal)();
    return 0;
  } finally {
    if (stopTunnel) {
      writeErr("Closing the tunnel.\n");
      await stopTunnel().catch(() => {});
    }
  }
}
