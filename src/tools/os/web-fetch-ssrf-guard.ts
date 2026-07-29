import { lookup as dnsLookup } from "node:dns/promises";

/**
 * Resolves a hostname to its candidate addresses. Injectable so tests can
 * exercise the SSRF guard without real DNS. Mirrors the subset of
 * `dns.promises.lookup(host, { all: true })` we rely on.
 */
export type HostLookup = (
  hostname: string,
) => Promise<readonly { address: string; family: number }[]>;

const defaultLookup: HostLookup = async (hostname) => {
  return dnsLookup(hostname, { all: true, verbatim: true });
};

/** Thrown when a URL points at a private / internal / reserved address. */
export class SsrfBlockedError extends Error {
  constructor(
    message: string,
    readonly host: string,
  ) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/**
 * Parse a URL and reject anything that is not plain `http(s)`. Keeps the
 * fetch surface bounded to the two schemes curl + readability understand.
 */
export function parseHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError(`invalid URL ${JSON.stringify(raw)}`, "");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockedError(
      `only http/https URLs are supported (got ${url.protocol})`,
      url.hostname,
    );
  }
  return url;
}

function parseIpv4ToInt(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result >>> 0;
}

/** Blocked IPv4 CIDR ranges as `[network, prefixLength]` pairs. */
const BLOCKED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incl. 169.254.169.254 metadata)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmark
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved (incl. 255.255.255.255 broadcast)
];

function isBlockedIpv4(value: string): boolean {
  const ip = parseIpv4ToInt(value);
  if (ip === null) return false;
  for (const [network, prefix] of BLOCKED_IPV4) {
    const net = parseIpv4ToInt(network);
    if (net === null) continue;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((ip & mask) === (net & mask)) return true;
  }
  return false;
}

function parseIpv6ToBigInt(value: string): bigint | null {
  let input = value.split("%")[0] ?? value; // strip zone id
  // Embedded IPv4 tail (e.g. ::ffff:127.0.0.1) → convert to two hextets.
  const lastColon = input.lastIndexOf(":");
  const tail = lastColon >= 0 ? input.slice(lastColon + 1) : "";
  if (tail.includes(".")) {
    const v4 = parseIpv4ToInt(tail);
    if (v4 === null) return null;
    const hi = (v4 >>> 16) & 0xffff;
    const lo = v4 & 0xffff;
    input = `${input.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tailGroups = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const missing = 8 - head.length - tailGroups.length;
  if (missing < 0) return null;
  const groups =
    halves.length === 2
      ? [...head, ...Array<string>(missing).fill("0"), ...tailGroups]
      : head;
  if (groups.length !== 8) return null;
  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    result = (result << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return result;
}

/** Blocked IPv6 CIDR ranges as `[network, prefixLength]` pairs. */
const BLOCKED_IPV6: ReadonlyArray<readonly [string, number]> = [
  ["::1", 128], // loopback
  ["::", 128], // unspecified
  ["fc00::", 7], // unique-local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["2001:db8::", 32], // documentation
];

function isBlockedIpv6(value: string): boolean {
  const ip = parseIpv6ToBigInt(value);
  if (ip === null) return false;
  // IPv4-mapped (::ffff:0:0/96) → re-check the embedded IPv4.
  const mappedMask = (1n << 128n) - (1n << 32n);
  const mappedNet = 0xffffn << 32n;
  if ((ip & mappedMask) === mappedNet) {
    const embedded = Number(ip & 0xffffffffn) >>> 0;
    const dotted = [
      (embedded >>> 24) & 0xff,
      (embedded >>> 16) & 0xff,
      (embedded >>> 8) & 0xff,
      embedded & 0xff,
    ].join(".");
    if (isBlockedIpv4(dotted)) return true;
  }
  for (const [network, prefix] of BLOCKED_IPV6) {
    const net = parseIpv6ToBigInt(network);
    if (net === null) continue;
    const mask =
      prefix === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - prefix)) - 1n);
    if ((ip & mask) === (net & mask)) return true;
  }
  return false;
}

/** True when an IP literal falls in a blocked (private/internal) range. */
export function isBlockedIp(value: string): boolean {
  return isBlockedIpv4(value) || isBlockedIpv6(value);
}

export interface AssertHostAllowedOptions {
  lookup?: HostLookup;
}

/**
 * Resolve `url`'s hostname and reject when **any** resolved address is in a
 * blocked range. Returns a single safe address to pin curl to via
 * `--resolve`, which closes the DNS-rebinding gap between this check and the
 * actual connection. Throws {@link SsrfBlockedError} on any violation.
 */
export async function assertHostAllowed(
  url: URL,
  options: AssertHostAllowedOptions = {},
): Promise<string> {
  const lookup = options.lookup ?? defaultLookup;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host.length === 0) {
    throw new SsrfBlockedError("empty host", host);
  }
  // IP literals do not need DNS — reject them directly so a custom/test
  // lookup cannot whitewash a private target by returning a public pin.
  if (isBlockedIp(host)) {
    throw new SsrfBlockedError(
      `${host} is a private/internal address`,
      host,
    );
  }
  let addresses: readonly { address: string; family: number }[];
  try {
    addresses = await lookup(host);
  } catch (err) {
    throw new SsrfBlockedError(
      `DNS resolution failed for ${host}: ${(err as Error).message}`,
      host,
    );
  }
  if (addresses.length === 0) {
    throw new SsrfBlockedError(`no addresses resolved for ${host}`, host);
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new SsrfBlockedError(
        `${host} resolves to a private/internal address (${address})`,
        host,
      );
    }
  }
  return addresses[0]!.address;
}
