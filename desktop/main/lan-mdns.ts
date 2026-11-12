/**
 * ATO-1067 — the mDNS half of "Find on my network": the query packet we
 * multicast and the reading of the answers (RFC 6762 / RFC 6763 DNS-SD).
 *
 * Pure: bytes in, bytes or plain records out. The socket is in
 * lan-discovery-ipc.ts.
 *
 * Checked 12.11.2026: Ollama, LM Studio and llama.cpp's llama-server do not
 * advertise themselves over mDNS out of the box (Ollama declined it in
 * ollama/ollama#751; #10283 is still open). A server is only found this way
 * when something on that PC advertises it: a DNS-SD bridge (`_saturn._tcp`),
 * a hand-made `dns-sd -R` / `avahi-publish` entry, or a plain `_http._tcp`
 * web service on a model server's port. The subnet probe does the rest.
 */

/** The DNS-SD service types we ask for. `_http._tcp` also brings printers and routers; only those that answer like a model server are kept. */
export const MDNS_SERVICE_TYPES: readonly string[] = [
  "_http._tcp.local",
  "_ollama._tcp.local",
  "_llm._tcp.local",
  "_openai._tcp.local",
  "_saturn._tcp.local",
];

export const MDNS_ADDRESS = "224.0.0.251";
export const MDNS_PORT = 5353;

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;

export type MdnsRecord =
  | { name: string; type: "PTR"; target: string }
  | { name: string; type: "SRV"; port: number; target: string }
  | { name: string; type: "TXT"; entries: string[] }
  | { name: string; type: "A"; address: string };

/** One advertised service, put together from the PTR, SRV, TXT and A records. */
export interface MdnsService {
  /** The instance name, e.g. `gpu-box` from `gpu-box._ollama._tcp.local`. */
  instance: string;
  serviceType: string;
  host: string;
  port: number;
  /** IPv4 from an A record in the same answers, else null (the caller falls back to the sender's address). */
  address: string | null;
  txt: string[];
}

function lower(name: string): string {
  return name.toLowerCase().replace(/\.$/, "");
}

function encodeName(name: string): number[] {
  const out: number[] = [];
  for (const label of name.replace(/\.$/, "").split(".")) {
    const bytes = Array.from(Buffer.from(label, "utf8"));
    if (bytes.length === 0 || bytes.length > 63) throw new Error(`bad DNS label in ${name}`);
    out.push(bytes.length, ...bytes);
  }
  out.push(0);
  return out;
}

/**
 * A standard query with one PTR question per service type. The QU bit asks
 * for a unicast answer; since we send from an ephemeral port (a one-shot
 * query, RFC 6762 §5.1) responders answer to that port anyway.
 */
export function buildMdnsQuery(serviceTypes: readonly string[] = MDNS_SERVICE_TYPES, id = 0): Buffer {
  const bytes: number[] = [
    (id >> 8) & 0xff, id & 0xff, // id
    0, 0, // flags: standard query
    (serviceTypes.length >> 8) & 0xff, serviceTypes.length & 0xff, // QDCOUNT
    0, 0, 0, 0, 0, 0, // AN, NS, AR
  ];
  for (const t of serviceTypes) bytes.push(...encodeName(t), 0, TYPE_PTR, 0x80, 0x01);
  return Buffer.from(bytes);
}

/** A name at `offset`, following compression pointers (with a guard against loops). */
function readName(buf: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = offset;
  let next = -1;
  for (let hops = 0; hops < 64; hops++) {
    if (pos >= buf.length) throw new Error("name runs past the packet");
    const len = buf[pos];
    if (len === 0) {
      if (next < 0) next = pos + 1;
      return { name: labels.join("."), next };
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error("pointer runs past the packet");
      if (next < 0) next = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    if ((len & 0xc0) !== 0) throw new Error("unknown label type");
    if (pos + 1 + len > buf.length) throw new Error("label runs past the packet");
    labels.push(buf.toString("utf8", pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  throw new Error("too many name hops");
}

/**
 * The records of an mDNS response (answers, authority and additional
 * sections), the kinds we read only; anything else is skipped. A query or a
 * malformed packet gives []. Never throws.
 */
export function parseMdnsPacket(buf: Buffer): MdnsRecord[] {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return [];
    const flags = buf.readUInt16BE(2);
    if ((flags & 0x8000) === 0) return []; // a question, not an answer
    const qd = buf.readUInt16BE(4);
    const rrCount = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
    let pos = 12;
    for (let i = 0; i < qd; i++) pos = readName(buf, pos).next + 4;
    const out: MdnsRecord[] = [];
    for (let i = 0; i < rrCount && pos < buf.length; i++) {
      const { name, next } = readName(buf, pos);
      if (next + 10 > buf.length) break;
      const type = buf.readUInt16BE(next);
      const rdlen = buf.readUInt16BE(next + 8);
      const rd = next + 10;
      if (rd + rdlen > buf.length) break;
      if (type === TYPE_PTR) out.push({ name, type: "PTR", target: readName(buf, rd).name });
      else if (type === TYPE_SRV && rdlen >= 7) out.push({ name, type: "SRV", port: buf.readUInt16BE(rd + 4), target: readName(buf, rd + 6).name });
      else if (type === TYPE_A && rdlen === 4) out.push({ name, type: "A", address: `${buf[rd]}.${buf[rd + 1]}.${buf[rd + 2]}.${buf[rd + 3]}` });
      else if (type === TYPE_TXT) {
        const entries: string[] = [];
        for (let p = rd; p < rd + rdlen; ) {
          const l = buf[p];
          if (l > 0 && p + 1 + l <= rd + rdlen) entries.push(buf.toString("utf8", p + 1, p + 1 + l));
          p += 1 + l;
        }
        out.push({ name, type: "TXT", entries });
      }
      pos = rd + rdlen;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The services the records describe: each PTR for one of `serviceTypes`
 * whose instance has an SRV record, joined with its TXT and the host's A
 * record when the answers carry them. Each instance once.
 */
export function servicesFromRecords(records: readonly MdnsRecord[], serviceTypes: readonly string[] = MDNS_SERVICE_TYPES): MdnsService[] {
  const wanted = new Set(serviceTypes.map(lower));
  const srv = new Map<string, { port: number; target: string }>();
  const txt = new Map<string, string[]>();
  const a = new Map<string, string>();
  for (const r of records) {
    const key = lower(r.name);
    if (r.type === "SRV") srv.set(key, { port: r.port, target: r.target });
    else if (r.type === "TXT") txt.set(key, r.entries);
    else if (r.type === "A" && !a.has(key)) a.set(key, r.address);
  }
  const seen = new Set<string>();
  const out: MdnsService[] = [];
  for (const r of records) {
    if (r.type !== "PTR") continue;
    const serviceType = lower(r.name);
    if (!wanted.has(serviceType)) continue;
    const full = lower(r.target);
    if (seen.has(full)) continue;
    const s = srv.get(full);
    if (!s || !s.port) continue;
    seen.add(full);
    const suffix = "." + serviceType;
    const instance = r.target.replace(/\.$/, "");
    out.push({
      instance: instance.toLowerCase().endsWith(suffix) ? instance.slice(0, instance.length - suffix.length) : instance,
      serviceType,
      host: s.target.replace(/\.$/, ""),
      port: s.port,
      address: a.get(lower(s.target)) ?? null,
      txt: txt.get(full) ?? [],
    });
  }
  return out;
}
