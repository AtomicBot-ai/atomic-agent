/**
 * ATO-1067 — the "Find on my network" routes (renderer/lan-find.js).
 *
 *   lan:find    model servers on the local network: an mDNS query, plus a
 *               bounded probe of our own private /24 on the known ports
 *               (lan-discovery.ts KNOWN_PORTS). Each hit is checked like
 *               lan:check, so it comes with its kind and models.
 *   lan:check   one address: does it answer, which server, which models,
 *               how fast, or why not in plain words.
 *
 * View-only: TCP connects and GET /v1/models, GET /api/tags. No prompt is
 * ever sent and nothing is saved; the person copies a found address into
 * the existing URL field themselves (one click).
 */

import { createSocket, type Socket } from "node:dgram";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { ipcMain } from "electron";

import {
  CHECK_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  KIND_WORDS,
  KNOWN_PORTS,
  PROBE_CONCURRENCY,
  classifyServer,
  failureWords,
  hostsToProbe,
  isPrivateV4,
  mapLimit,
  normalizeCheckUrl,
  subnetsFromInterfaces,
  type CheckFailure,
  type GetAnswer,
  type IfaceAddr,
  type ServerKind,
} from "./lan-discovery.js";
import { MDNS_ADDRESS, MDNS_PORT, buildMdnsQuery, parseMdnsPacket, servicesFromRecords, type MdnsRecord } from "./lan-mdns.js";

/** How long we listen for mDNS answers. */
const MDNS_WINDOW_MS = 1500;
/** At most this many mDNS services are checked (a busy `_http._tcp` network has dozens of printers). */
const MDNS_MAX_CHECKS = 24;

export type CheckAnswer =
  | { ok: true; url: string; kind: ServerKind; kindWord: string; models: string[]; needsKey: boolean; latencyMs: number }
  | { ok: false; url: string | null; reason: CheckFailure; error: string };

export interface FoundServer {
  url: string;
  host: string;
  /** The mDNS instance name, when it was advertised. */
  name: string | null;
  via: "mdns" | "scan";
  kind: ServerKind;
  kindWord: string;
  models: string[];
  needsKey: boolean;
  latencyMs: number;
}

export interface FindAnswer {
  ok: true;
  servers: FoundServer[];
  /** The networks probed, e.g. `192.168.1.0/24`; empty when this computer is on no private network. */
  networks: string[];
  mdnsAnswered: boolean;
}

/** Node's fetch puts the socket error's code in `cause`; a timeout is a DOMException whose `code` is a number, so its name is used. */
function codeOf(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown; name?: unknown } } | null;
  for (const c of [e?.cause?.code, e?.code, e?.cause?.name, e?.name]) if (typeof c === "string" && c) return c;
  return "";
}

async function getJson(url: string, timeoutMs: number): Promise<GetAnswer> {
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    let json: unknown = null;
    try {
      json = JSON.parse(await res.text());
    } catch { /* not JSON */ }
    return { status: res.status, json };
  } catch (err) {
    return { error: codeOf(err) };
  }
}

function portOf(root: string): number {
  const u = new URL(root);
  return u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
}

/** lan:check for an already-normalized root URL. */
async function checkRoot(root: string, timeoutMs = CHECK_TIMEOUT_MS): Promise<CheckAnswer> {
  const started = Date.now();
  const v1 = await getJson(`${root}/v1/models`, timeoutMs);
  const latencyMs = Date.now() - started;
  // A host that did not answer at all is not asked a second time.
  const tags: GetAnswer = "error" in v1 ? v1 : await getJson(`${root}/api/tags`, timeoutMs);
  const c = classifyServer(v1, tags, portOf(root));
  if (!c.ok) return { ok: false, url: root, reason: c.reason, error: failureWords(c.reason) };
  return { ok: true, url: root, kind: c.kind, kindWord: KIND_WORDS[c.kind], models: c.models, needsKey: c.needsKey, latencyMs };
}

export async function checkServerUrl(raw: unknown): Promise<CheckAnswer> {
  const root = normalizeCheckUrl(raw);
  if (!root) return { ok: false, url: null, reason: "bad-url", error: failureWords("bad-url") };
  return checkRoot(root);
}

function tcpOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (open: boolean) => { sock.removeAllListeners(); sock.destroy(); resolve(open); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** mDNS: one query out of each private interface, answers collected for MDNS_WINDOW_MS. */
function mdnsBrowse(ownAddrs: string[]): Promise<{ answered: boolean; targets: Array<{ host: string; port: number; name: string }> }> {
  return new Promise((resolve) => {
    const records: MdnsRecord[] = [];
    const senders = new Map<string, string>(); // a record's name → the address that sent it
    let answered = false;
    let made: Socket | null = null;
    try { made = createSocket({ type: "udp4", reuseAddr: true }); } catch { /* no UDP here */ }
    if (!made) {
      resolve({ answered: false, targets: [] });
      return;
    }
    const sock: Socket = made;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try { sock.close(); } catch { /* closed already */ }
      const targets: Array<{ host: string; port: number; name: string }> = [];
      for (const s of servicesFromRecords(records)) {
        const host = s.address ?? senders.get(s.host.toLowerCase()) ?? senders.get(`${s.instance}.${s.serviceType}`.toLowerCase()) ?? null;
        if (host && isPrivateV4(host) && !ownAddrs.includes(host)) targets.push({ host, port: s.port, name: s.instance });
      }
      resolve({ answered, targets });
    };
    sock.on("error", () => { /* a send that fails on one interface; the window still closes */ });
    sock.on("message", (msg, rinfo) => {
      const got = parseMdnsPacket(msg);
      if (!got.length) return;
      answered = true;
      for (const r of got) {
        records.push(r);
        senders.set(r.name.toLowerCase().replace(/\.$/, ""), rinfo.address);
        if (r.type === "SRV") senders.set(r.target.toLowerCase().replace(/\.$/, ""), rinfo.address);
      }
    });
    sock.bind(0, () => {
      const query = buildMdnsQuery();
      try { sock.setMulticastTTL(255); } catch { /* default TTL */ }
      for (const addr of ownAddrs.length ? ownAddrs : [null]) {
        try {
          if (addr) sock.setMulticastInterface(addr);
          sock.send(query, MDNS_PORT, MDNS_ADDRESS);
        } catch { /* this interface cannot send multicast */ }
      }
    });
    // Started before bind, so a socket that never binds still ends the search.
    setTimeout(finish, MDNS_WINDOW_MS);
  });
}

async function findServers(): Promise<FindAnswer> {
  const subnets = subnetsFromInterfaces(networkInterfaces() as Record<string, IfaceAddr[] | undefined>);
  const own = subnets.map((s) => s.self);
  const servers = new Map<string, FoundServer>();
  const keep = (c: CheckAnswer, host: string, via: "mdns" | "scan", name: string | null) => {
    if (!c.ok || servers.has(c.url)) return;
    servers.set(c.url, { url: c.url, host, name, via, kind: c.kind, kindWord: c.kindWord, models: c.models, needsKey: c.needsKey, latencyMs: c.latencyMs });
  };

  const mdns = (async () => {
    const found = await mdnsBrowse(own);
    await mapLimit(found.targets.slice(0, MDNS_MAX_CHECKS), 8, async (t) => keep(await checkRoot(`http://${t.host}:${t.port}`), t.host, "mdns", t.name));
    return found.answered;
  })();

  const scan = (async () => {
    const pairs = hostsToProbe(subnets).flatMap((host) => KNOWN_PORTS.map(({ port }) => ({ host, port })));
    const open = await mapLimit(pairs, PROBE_CONCURRENCY, async (p) => ((await tcpOpen(p.host, p.port, CONNECT_TIMEOUT_MS)) ? p : null));
    const hits = open.filter((p): p is { host: string; port: number } => p !== null);
    await mapLimit(hits, 8, async (p) => keep(await checkRoot(`http://${p.host}:${p.port}`), p.host, "scan", null));
  })();

  const [mdnsAnswered] = await Promise.all([mdns, scan]);
  const list = [...servers.values()].sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }) || a.url.localeCompare(b.url));
  return { ok: true, servers: list, networks: subnets.map((s) => `${s.prefix}.0/24`), mdnsAnswered };
}

export function wireLanDiscoveryIpc(): void {
  let running: Promise<FindAnswer> | null = null;
  // One search at a time: a second click while one runs gets the same answer.
  ipcMain.handle("lan:find", async (): Promise<FindAnswer> => {
    if (!running) running = findServers().finally(() => { running = null; });
    return running;
  });
  ipcMain.handle("lan:check", async (_event, url: unknown): Promise<CheckAnswer> => checkServerUrl(url));
}
