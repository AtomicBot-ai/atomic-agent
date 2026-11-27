import { lanUrls as defaultLanUrls, MIN_NETWORK_KEY_LENGTH } from "./serve-args.js";
import type { ServeRecord } from "./serve-reaper.js";

/**
 * ATO-2308: where the phone of `atag pair` reaches serve. Read from the
 * records live servers leave in `<stateDir>/serve/` (serve-reaper.ts),
 * newest first, so `atag pair` needs no flags in the usual case.
 *
 * - Same Wi-Fi: serve must listen beyond this machine (`--host 0.0.0.0`
 *   or a LAN address); the QR then holds its LAN address.
 * - `--remote`: cloudflared fronts serve's loopback port, wherever serve listens.
 *   Refused unless serve recorded a key of MIN_NETWORK_KEY_LENGTH or more,
 *   the same bar `atag serve` sets for a network host (ATO-1126).
 * - `--url`: the operator's own address (a reverse proxy, a VPN name).
 */

export type PairTarget =
  /** The phone opens `baseUrl`; `others` are the other LAN addresses, printed as a hint. */
  | { ok: true; kind: "lan"; baseUrl: string; others: string[] }
  /** cloudflared is pointed at `originUrl`. */
  | { ok: true; kind: "remote"; originUrl: string }
  | { ok: false; error: string };

export interface PairTargetInput {
  records: readonly ServeRecord[];
  remote: boolean;
  url: string | null;
  isAlive: (pid: number) => boolean;
  lanUrls?: (host: string, port: number) => string[];
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/i;
const ANY = new Set(["0.0.0.0", "::", "[::]"]);

function authority(host: string, port: number): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${h}:${port}`;
}

/** `http(s)://host[:port]` with no path, or `null`. */
export function normalizeBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin;
}

export function resolvePairTarget(input: PairTargetInput): PairTarget {
  if (input.url !== null) {
    if (input.remote) return { ok: false, error: "use --url or --remote, not both" };
    const base = normalizeBaseUrl(input.url);
    if (!base) return { ok: false, error: `--url must be an http:// or https:// address, not ${input.url}` };
    return { ok: true, kind: "lan", baseUrl: base, others: [] };
  }
  const live = input.records
    .filter((r) => input.isAlive(r.pid))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const serve = live[0];
  if (!serve) {
    return {
      ok: false,
      error: "no atag serve is running. Start it first: atag serve --host 0.0.0.0 (same Wi-Fi), or atag serve and then atag pair --remote",
    };
  }
  const host = serve.host.trim();
  if (input.remote) {
    if (serve.strongKey !== true) return { ok: false, error: weakKeyError(serve.strongKey === false) };
    const target = ANY.has(host) || LOOPBACK.test(host) ? "127.0.0.1" : host;
    return { ok: true, kind: "remote", originUrl: `http://${authority(target, serve.port)}` };
  }
  if (LOOPBACK.test(host)) {
    return {
      ok: false,
      error:
        `atag serve listens on this computer only (${host}), so a phone cannot reach it. ` +
        "Restart it with atag serve --host 0.0.0.0 to pair over the same Wi-Fi, or run atag pair --remote",
    };
  }
  if (ANY.has(host)) {
    const urls = (input.lanUrls ?? defaultLanUrls)(host.replace(/^\[|\]$/g, ""), serve.port);
    const [first, ...others] = urls;
    if (!first) return { ok: false, error: "this computer has no network address a phone can reach; join a Wi-Fi network, or run atag pair --remote" };
    return { ok: true, kind: "lan", baseUrl: first, others };
  }
  return { ok: true, kind: "lan", baseUrl: `http://${authority(host, serve.port)}`, others: [] };
}

function weakKeyError(known: boolean): string {
  const why = known
    ? `the API key of the running atag serve is shorter than ${MIN_NETWORK_KEY_LENGTH} characters and could be guessed`
    : "the running atag serve is from an older version and does not say how long its API key is";
  return (
    `--remote puts serve on the public internet, and ${why}. ` +
    "Restart atag serve without --api-key (it then uses its generated key) or with a key of at least " +
    `${MIN_NETWORK_KEY_LENGTH} characters (for example: export ATOMIC_AGENT_API_KEY=$(openssl rand -hex 24)), then run atag pair --remote again`
  );
}
