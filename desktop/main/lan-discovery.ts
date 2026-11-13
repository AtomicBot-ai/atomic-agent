/**
 * ATO-1067 — "Find on my network": find a PC on the local network that runs
 * a model server, and check one address. The pure half: which addresses and
 * ports are probed, how a server's answers are read, and the words for what
 * went wrong. The sockets and fetches are in lan-discovery-ipc.ts, the mDNS
 * packets in lan-mdns.ts.
 *
 * View-only: a probe is a TCP connect and GET /v1/models, GET /api/tags.
 * Nothing is ever sent to a model.
 */

/** The ports model servers listen on by default, and what usually sits there. */
export const KNOWN_PORTS: ReadonlyArray<{ port: number; kind: ServerKind }> = [
  { port: 8080, kind: "llama.cpp" },
  { port: 11434, kind: "ollama" },
  { port: 1234, kind: "lmstudio" },
  { port: 1337, kind: "atomic-chat" },
  { port: 8787, kind: "atomic-agent" }, // `atag serve` (src/cli/serve-args.ts)
];

/** At most this many /24 networks are probed (Wi-Fi plus a cable, say). */
export const MAX_SUBNETS = 2;
/** A TCP connect that takes longer than this counts as nobody there. */
export const CONNECT_TIMEOUT_MS = 350;
/** Connects in flight at once. */
export const PROBE_CONCURRENCY = 64;
/** The HTTP check's own limit, per request. */
export const CHECK_TIMEOUT_MS = 3000;

export type ServerKind = "llama.cpp" | "ollama" | "lmstudio" | "atomic-chat" | "atomic-agent" | "openai-compatible";

export const KIND_WORDS: Record<ServerKind, string> = {
  "llama.cpp": "llama.cpp server",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  "atomic-chat": "Atomic Chat",
  "atomic-agent": "Atomic Agent",
  "openai-compatible": "OpenAI-compatible server",
};

/** One interface address, as os.networkInterfaces() lists it (the fields read). */
export interface IfaceAddr {
  family: string | number;
  address: string;
  netmask: string;
  internal: boolean;
}

function v4(ip: string): number[] | null {
  const parts = String(ip ?? "").split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.map(Number);
}

/** RFC 1918 only: 10/8, 172.16/12, 192.168/16. Not loopback, link-local or CGNAT (Tailscale's 100.64/10). */
export function isPrivateV4(ip: string): boolean {
  const p = v4(ip);
  if (!p) return false;
  const [a, b] = p;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Virtual interfaces (containers, VMs) whose networks hold no other PC. */
const VIRTUAL_IFACE = /^(docker|br-|veth|vboxnet|vmnet|virbr|bridge\d|utun|awdl|llw|lo)/i;

export interface Subnet {
  /** Our own address on it. */
  self: string;
  /** The first three parts, e.g. `192.168.1`. */
  prefix: string;
  /** The last part of the first and last host address probed. */
  from: number;
  to: number;
}

/**
 * The networks to probe: one per private IPv4 interface address, never wider
 * than the /24 around our own address (a /16 office network is not swept),
 * narrower when the netmask is. Virtual interfaces are skipped; at most
 * MAX_SUBNETS, each /24 once.
 */
export function subnetsFromInterfaces(ifaces: Record<string, IfaceAddr[] | undefined>): Subnet[] {
  const out: Subnet[] = [];
  const seen = new Set<string>();
  for (const [name, list] of Object.entries(ifaces ?? {})) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const ad of list ?? []) {
      if (!ad || ad.internal || !(ad.family === "IPv4" || ad.family === 4)) continue;
      const ip = v4(ad.address);
      const mask = v4(ad.netmask);
      if (!ip || !mask || !isPrivateV4(ad.address)) continue;
      const prefix = ip.slice(0, 3).join(".");
      if (seen.has(prefix)) continue;
      // The last octet of the mask decides; anything wider than /24 is cut to /24.
      const m = mask[0] === 255 && mask[1] === 255 && mask[2] === 255 ? mask[3] : 0;
      const net = ip[3] & m;
      const bcast = net | (~m & 0xff);
      if (bcast - net < 2) continue; // /31, /32: no other host
      seen.add(prefix);
      out.push({ self: ad.address, prefix, from: net + 1, to: bcast - 1 });
      if (out.length >= MAX_SUBNETS) return out;
    }
  }
  return out;
}

/** Every host address of the subnets except our own ones. */
export function hostsToProbe(subnets: readonly Subnet[]): string[] {
  const own = new Set(subnets.map((s) => s.self));
  const out: string[] = [];
  for (const s of subnets) {
    for (let i = s.from; i <= s.to; i++) {
      const ip = `${s.prefix}.${i}`;
      if (!own.has(ip)) out.push(ip);
    }
  }
  return out;
}

/**
 * The address a person types, as the root URL the check uses:
 * `http(s)://host[:port]` plus any path except a trailing `/v1`. A bare
 * `host:port` gets `http://`. Null for anything else.
 */
export function normalizeCheckUrl(raw: unknown): string | null {
  let s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "http://" + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || !u.hostname) return null;
  const path = u.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
  return `${u.protocol}//${u.host}${path}`;
}

/** What one GET answered: its status and the parsed JSON body (null when not JSON), or the error code. */
export type GetAnswer = { status: number; json: unknown } | { error: string };

export type CheckFailure = "bad-url" | "refused" | "timeout" | "dns" | "unreachable" | "not-a-model-server" | "failed";

export type Classified =
  | { ok: true; kind: ServerKind; models: string[]; needsKey: boolean }
  | { ok: false; reason: CheckFailure };

function obj(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function ids(list: unknown, field: string): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const m of list) {
    const v = obj(m)?.[field];
    if (typeof v === "string" && v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** The kind a port usually means (KNOWN_PORTS), else a plain compat server. */
export function kindForPort(port: number): ServerKind {
  return KNOWN_PORTS.find((k) => k.port === port)?.kind ?? "openai-compatible";
}

/**
 * Which server answered and its models, from GET /v1/models and
 * GET /api/tags. `owned_by` tells most apart: llama-server says `llamacpp`,
 * our agent `atomic-agent`; Ollama answers /api/tags; LM Studio's
 * `organization_owner` is not certain, so the port decides past those. A
 * 401/403 is a server that asks for a key.
 */
export function classifyServer(v1: GetAnswer, tags: GetAnswer, port: number): Classified {
  const tagsBody = "status" in tags && tags.status === 200 ? obj(tags.json) : null;
  if (tagsBody && Array.isArray(tagsBody.models)) {
    return { ok: true, kind: "ollama", models: ids(tagsBody.models, "name"), needsKey: false };
  }
  if ("status" in v1) {
    const body = v1.status === 200 ? obj(v1.json) : null;
    if (body && Array.isArray(body.data)) {
      const owners = new Set(body.data.map((m) => obj(m)?.owned_by).filter((o): o is string => typeof o === "string"));
      let kind: ServerKind = kindForPort(port);
      if (owners.has("atomic-agent")) kind = "atomic-agent";
      else if (owners.has("llamacpp")) kind = "llama.cpp";
      else if (owners.has("library") && port === 11434) kind = "ollama";
      // A llama.cpp/Ollama port that lists models some other way is not called that.
      else if (kind === "llama.cpp" || kind === "atomic-agent") kind = "openai-compatible";
      return { ok: true, kind, models: ids(body.data, "id"), needsKey: false };
    }
    if (v1.status === 401 || v1.status === 403) return { ok: true, kind: kindForPort(port), models: [], needsKey: true };
    return { ok: false, reason: "not-a-model-server" };
  }
  if ("status" in tags) return { ok: false, reason: "not-a-model-server" };
  return { ok: false, reason: errorReason(v1.error) };
}

/** A network error's code (Node's fetch hides it in `cause`) as a failure reason. */
export function errorReason(code: string | undefined): CheckFailure {
  const c = String(code ?? "");
  if (c === "ECONNREFUSED" || c === "ECONNRESET") return "refused";
  if (c === "ETIMEDOUT" || c === "TimeoutError" || c === "AbortError" || c === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
  if (c === "ENOTFOUND" || c === "EAI_AGAIN") return "dns";
  if (c === "EHOSTUNREACH" || c === "ENETUNREACH" || c === "EHOSTDOWN") return "unreachable";
  return "failed";
}

/** What a failed check says, in plain words. */
export function failureWords(reason: CheckFailure): string {
  switch (reason) {
    case "bad-url": return "That is not an address. Type it like http://192.168.1.20:8080.";
    case "refused": return "That PC answers, but nothing listens on this port. Is the server running, and set to listen on the network, not only on 127.0.0.1?";
    case "timeout": return "No answer in time. The PC may be off or asleep, on another network, or a firewall blocks the port.";
    case "dns": return "That name could not be found on this network. Try the PC's IP address.";
    case "unreachable": return "That address cannot be reached from this computer. Check that both are on the same network.";
    case "not-a-model-server": return "Something answers there, but it is not a model server: it has no /v1/models or /api/tags.";
    default: return "The check failed. Try again, or check the address.";
  }
}

/** Runs `fn` over `items` with at most `limit` in flight, results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
