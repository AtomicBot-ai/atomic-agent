/**
 * ATO-2241: is a link's host this computer or the local network? Used by
 * mention-url.ts so a public link cannot redirect the read to a local
 * address (a router page, a dev server, a cloud metadata endpoint). A host
 * the person typed as local stays allowed: `@http://localhost:3000` is on
 * purpose. Names are judged by their text only, never resolved.
 */

function ipv4Local(a: number, b: number): boolean {
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

function parseIpv4(host: string): [number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return [parts[0] ?? 0, parts[1] ?? 0];
}

function ipv6Local(host: string): boolean {
  if (host === "::" || host === "::1") return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true;   // fc00::/7, unique local
  if (/^fe[89ab][0-9a-f]?:/.test(host)) return true;    // fe80::/10, link-local
  // An IPv4 address mapped into IPv6, written either way.
  const mapped = /^::ffff:(.+)$/.exec(host);
  if (!mapped || !mapped[1]) return false;
  const dotted = parseIpv4(mapped[1]);
  if (dotted) return ipv4Local(dotted[0], dotted[1]);
  const hex = /^([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(mapped[1]);
  if (!hex || !hex[1]) return false;
  const high = parseInt(hex[1], 16);
  return ipv4Local(high >> 8, high & 0xff);
}

/** `hostname` as `new URL(...).hostname` gives it (IPv6 in brackets). */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const v4 = parseIpv4(host);
  if (v4) return ipv4Local(v4[0], v4[1]);
  return host.includes(":") && ipv6Local(host);
}
