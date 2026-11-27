import { RAW_MODEL_PREFIX } from "../http/route-raw-model.js";
import { isLoopbackListenHost, lanUrls as defaultLanUrls, MIN_NETWORK_KEY_LENGTH } from "./serve-args.js";
import type { ServeRecord } from "./serve-reaper.js";

/**
 * ATO-2758: who can reach the shared model right now, read from the
 * records live servers leave in `<stateDir>/serve/` (as `atag pair`
 * does). `models share` only flips a switch; whether anything answers,
 * and from where, depends on the serve that runs. Like LM Studio, which
 * lists network addresses only while "Serve on Local Network" is on, the
 * summary shows other-device addresses only for a serve that listens on
 * the network, and says so plainly when no serve runs.
 */

export type ShareReach =
  /** No live serve on record: the switch is on, nothing answers yet. */
  | { kind: "stopped"; port: number; local: string }
  /** serve listens on this computer only. */
  | { kind: "local"; port: number; local: string }
  /** serve listens on the network; `lan` are the addresses other devices use. */
  | { kind: "network"; port: number; local: string; lan: string[] };

export interface ShareReachInput {
  records: readonly ServeRecord[];
  isAlive: (pid: number) => boolean;
  /** `--port`, when given: only a serve on that port counts. */
  port: number | null;
  lanUrls?: (host: string, port: number) => string[];
}

const DEFAULT_PORT = 8787;

function authority(host: string, port: number): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${h}:${port}`;
}

export function resolveShareReach(input: ShareReachInput): ShareReach {
  const serve = input.records
    .filter((r) => input.isAlive(r.pid) && (input.port === null || r.port === input.port))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!serve) {
    const port = input.port ?? DEFAULT_PORT;
    return { kind: "stopped", port, local: `http://127.0.0.1:${port}${RAW_MODEL_PREFIX}` };
  }
  const host = serve.host.trim().replace(/^\[|\]$/g, "");
  const port = serve.port;
  if (isLoopbackListenHost(host)) {
    return { kind: "local", port, local: `http://${authority(host === "localhost" ? "127.0.0.1" : host, port)}${RAW_MODEL_PREFIX}` };
  }
  if (host === "0.0.0.0" || host === "::") {
    const lan = (input.lanUrls ?? defaultLanUrls)(host, port).map((origin) => `${origin}${RAW_MODEL_PREFIX}`);
    return { kind: "network", port, local: `http://127.0.0.1:${port}${RAW_MODEL_PREFIX}`, lan };
  }
  // One named address (a LAN IP, a hostname): serve answers there only, this computer included.
  const only = `http://${authority(host, port)}${RAW_MODEL_PREFIX}`;
  return { kind: "network", port, local: only, lan: [only] };
}

/** How to put serve on the network, and why that is a second key. */
export function networkServeHint(port: number): string[] {
  const portArg = port === DEFAULT_PORT ? "" : ` --port ${port}`;
  return [
    `To reach it from other devices, restart serve on the network: atomic-agent serve --host 0.0.0.0${portArg} --api-key <key>`,
    `  That --api-key is not the key above: it guards the agent itself (its tools, files and settings),`,
    `  so serve wants one you choose (${MIN_NETWORK_KEY_LENGTH}+ characters) before it opens to the network. Keep it on`,
    "  this computer. The other app needs only the API key above, which reaches the bare model and nothing else.",
  ];
}

export function formatShareSummary(input: { key: string; reach: ShareReach; rotated: boolean }): string {
  const { reach } = input;
  const rotated = input.rotated ? " with a new key (apps using the old one now get 401)" : "";
  const lines: string[] = [];
  if (reach.kind === "stopped") {
    lines.push(
      `Model sharing is switched on${rotated}, but atomic-agent serve is not running, so nothing answers yet.`,
      `Start it with: atomic-agent serve${reach.port === DEFAULT_PORT ? "" : ` --port ${reach.port}`}`,
      "",
      "Then paste these into the other app (OpenAI-compatible):",
    );
  } else {
    lines.push(`Model sharing is on${rotated}.`, "Paste these into the other app (OpenAI-compatible):");
  }
  lines.push(`  Base URL, this computer:   ${reach.local}`);
  if (reach.kind === "network") {
    for (const url of reach.lan) if (url !== reach.local) lines.push(`  Base URL, other devices:   ${url}`);
  }
  lines.push(`  API key:                   ${input.key}`, "");
  if (reach.kind === "network") {
    if (reach.lan.length === 0) lines.push("serve listens on the network, but this computer has no network address right now (join a Wi-Fi network).");
    lines.push("Warning: traffic on the local network is plain http; anyone on the same network can read it.");
  } else {
    if (reach.kind === "local") lines.push("Only apps on this computer can reach it: serve listens on this computer only.");
    lines.push(...networkServeHint(reach.port));
  }
  lines.push("One request at a time: a second one gets 429 while the first runs. Stop with: atomic-agent models share --off");
  return `${lines.join("\n")}\n`;
}
