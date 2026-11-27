/**
 * ATO-2483: the packets that announce our shared model on the local
 * network (RFC 6762 mDNS / RFC 6763 DNS-SD), so "Find on my network" on
 * another computer lists it without anyone typing an IP.
 *
 * Pure: plain values in, bytes out. The socket is in model-share-announce.ts.
 *
 * What is announced: one `_atomic-model._tcp.local` instance named after
 * this computer, its port, this computer's private IPv4 addresses and a
 * TXT saying where the OpenAI-compatible API is (`path=/raw/v1`) and that
 * it needs a key. Never the key itself, and never the model name.
 * The precedent is how Bonjour-aware apps advertise a server (AirPlay,
 * printers, Home Assistant's `_home-assistant._tcp`); LM Studio and Ollama
 * do not announce, which is why "Find on my network" also probes ports.
 */

import { encodeName, type MdnsQuestion } from "./lan-mdns.js";

export const SHARE_SERVICE_TYPE = "_atomic-model._tcp.local";
/** The DNS-SD meta-query "which service types are here?" (RFC 6763 §9). */
export const SERVICES_META_QUERY = "_services._dns-sd._udp.local";
/** What the TXT record says; discovery reads `path`. */
export const SHARE_TXT: readonly string[] = ["path=/raw/v1", "api=openai", "auth=key", "v=1"];
/** Seconds an answer is cached by the other side (RFC 6762 §10: 120 for host records). */
export const ANNOUNCE_TTL = 120;

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;
const TYPE_ANY = 255;
const CLASS_IN = 1;
/** The cache-flush bit on records only this host owns (SRV, TXT, A). */
const CACHE_FLUSH = 0x8000;

export interface ShareAnnouncement {
  /** The instance label, e.g. `Nadyas-MacBook-Pro` (instanceLabel). */
  instance: string;
  /** This computer's mDNS host label, without `.local`. */
  host: string;
  port: number;
  /** Private IPv4 addresses of this computer, one A record each. */
  addresses: readonly string[];
}

/** A host name as an instance and host label: letters, digits and dashes, at most 63 bytes, never empty. */
export function instanceLabel(hostname: string): string {
  const first = String(hostname ?? "").replace(/\.local\.?$/i, "").split(".")[0] ?? "";
  const clean = first.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  return clean || "atomic-agent";
}

function u16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function record(name: string, type: number, cls: number, ttl: number, rdata: number[]): number[] {
  return [...encodeName(name), ...u16(type), ...u16(cls), ...u32(ttl), ...u16(rdata.length), ...rdata];
}

function txtData(entries: readonly string[]): number[] {
  const out: number[] = [];
  for (const e of entries) {
    const bytes = Array.from(Buffer.from(e, "utf8")).slice(0, 255);
    out.push(bytes.length, ...bytes);
  }
  return out.length ? out : [0];
}

function ipv4(address: string): number[] | null {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255) ? parts : null;
}

export function instanceName(a: ShareAnnouncement): string {
  return `${a.instance}.${SHARE_SERVICE_TYPE}`;
}

/**
 * The response that announces (ttl > 0) or withdraws (ttl 0, the
 * "goodbye" of RFC 6762 §10.1) the shared model: PTR, SRV, TXT and one A
 * per address, all as answers. `id` echoes a legacy one-shot query's id
 * (RFC 6762 §6.7); multicast announcements use 0.
 */
export function buildShareResponse(a: ShareAnnouncement, options: { ttl?: number; id?: number } = {}): Buffer {
  const ttl = options.ttl ?? ANNOUNCE_TTL;
  const full = instanceName(a);
  const target = `${a.host}.local`;
  const answers: number[][] = [
    record(SHARE_SERVICE_TYPE, TYPE_PTR, CLASS_IN, ttl, encodeName(full)),
    record(full, TYPE_SRV, CLASS_IN | CACHE_FLUSH, ttl, [...u16(0), ...u16(0), ...u16(a.port), ...encodeName(target)]),
    record(full, TYPE_TXT, CLASS_IN | CACHE_FLUSH, ttl, txtData(SHARE_TXT)),
  ];
  for (const address of a.addresses) {
    const bytes = ipv4(address);
    if (bytes) answers.push(record(target, TYPE_A, CLASS_IN | CACHE_FLUSH, ttl, bytes));
  }
  const id = options.id ?? 0;
  const header = [...u16(id), 0x84, 0x00, 0, 0, ...u16(answers.length), 0, 0, 0, 0];
  return Buffer.from([...header, ...answers.flat()]);
}

/** The meta-query answer: one PTR naming our service type. */
export function buildServicesResponse(options: { ttl?: number; id?: number } = {}): Buffer {
  const ttl = options.ttl ?? ANNOUNCE_TTL;
  const answer = record(SERVICES_META_QUERY, TYPE_PTR, CLASS_IN, ttl, encodeName(SHARE_SERVICE_TYPE));
  return Buffer.from([...u16(options.id ?? 0), 0x84, 0x00, 0, 0, 0, 1, 0, 0, 0, 0, ...answer]);
}

export type QueryMatch = "share" | "services" | null;

/** Which of our answers a query asks for, if any. Names compare without case and trailing dot. */
export function matchShareQuery(questions: readonly MdnsQuestion[], a: ShareAnnouncement): QueryMatch {
  const norm = (n: string) => n.toLowerCase().replace(/\.$/, "");
  const ours = new Set([SHARE_SERVICE_TYPE, instanceName(a), `${a.host}.local`].map(norm));
  let services = false;
  for (const q of questions) {
    const n = norm(q.name);
    if (ours.has(n) && [TYPE_PTR, TYPE_SRV, TYPE_TXT, TYPE_A, TYPE_ANY].includes(q.type)) return "share";
    if (n === norm(SERVICES_META_QUERY) && (q.type === TYPE_PTR || q.type === TYPE_ANY)) services = true;
  }
  return services ? "services" : null;
}
