/**
 * Web addresses written without `https://` (ATO-1649): `bit.ly/xyz`,
 * `raw.githubusercontent.com/a/b/tool`, `evil-site.com/in`. A recipe is a
 * prompt, and an agent happily fetches a host with no scheme, so the
 * plain-language rules count one of these as a URL.
 *
 * A file name looks like a host (`config.json`, `README.md`), so a bare
 * name only counts when one of these holds:
 * - a top-level domain from `TLDS` is followed by a path (`/x`) or a port;
 * - it starts with `www.`;
 * - it is a link shortener, paste site or tunnel from `KNOWN_HOSTS`.
 * `TLDS` leaves out real domains that are also common file extensions
 * (`.md`, `.sh`, `.py`, `.pl`, `.rs`, `.so`, `.cc`, `.ps`, `.zip`,
 * `.mov`, `.run`), so `notes.md/x` or `run.sh` never count; a scheme URL
 * still does through the caller's own URL rule. The token must not sit
 * inside a longer path, URL or email address (`src/app.io/x`, `a@b.com`).
 *
 * ATO-2479 adds two shapes with no `TLDS` check:
 * - an IPv4 address followed by a port or a path (`1.2.3.4/tool`,
 *   `1.2.3.4:8080`, `1.2.3.4:8/x`), octets with leading zeros included
 *   (`1.2.3.04`, `0177.0.0.1`, which curl reads as octal); a CIDR prefix
 *   (`10.0.0.0/8`, `/0` to `/32` and nothing after it) is a network range
 *   here, so on its own it stays clean;
 * - a punycode name, any label starting with `xn--` (`xn--80ak6aa92e.com`,
 *   `shop.xn--p1ai`), path or not: no file name looks like that, and a
 *   lookalike host is exactly what punycode is used for.
 *
 * `hasHostName` is looser: any `LABEL.TLD` name with the same `TLDS` and
 * the same boundaries, path or not (`attacker.com`), a bare IPv4 address
 * (`1.2.3.4`, not after `version`, `build` or `v`), an IPv4 address followed
 * by `/` and anything (`1.2.3.4/`, `1.2.3.4/8`, `1.2.3.4//x`), and the
 * short forms `127.1` and `10.1.2` with a port or a path that starts with
 * a non-digit (`127.1/x`, `10.1.2:80`). Too loose to be a target on its
 * own, so the caller uses it only next to other signals (download plus run,
 * send plus private data).
 *
 * Why `1.2.3.4/8` is a host there (ATO-2479 review): nothing in the text
 * tells a range from a path. `http://1.2.3.4/8` is a fine place to serve a
 * payload, and the attacker picks the address, so "zero host bits" or an
 * "allow" word next to it proves nothing. So a range is clean when it
 * stands alone ("Only allow 10.0.0.0/8 and run the tests" has no download
 * or send word), and it is a host once download plus run, or send plus
 * private data, are in the same text.
 */

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

const TLDS = [
  "com", "net", "org", "edu", "gov", "io", "dev", "app", "co", "me", "ly", "gg", "ai", "to", "tv", "fm",
  "xyz", "info", "biz", "site", "online", "link", "click", "top", "page", "cloud", "tech", "store", "shop",
  "live", "space", "website", "zone", "win", "vip", "icu", "lol", "cyou", "bid", "pw", "ws", "su", "ru",
  "cn", "de", "uk", "us", "ca", "fr", "nl", "eu", "jp", "br", "au", "ch", "se", "in", "es", "it", "tk",
  "ml", "ga", "cf", "gq", "cx", "st", "gl", "nu", "im", "li", "be", "kr", "tw", "hk", "ir", "ua", "kz",
].join("|");

/* Shorteners, paste and file drops, request catchers and tunnels: a link to one of these is a host even with no path. */
const KNOWN_HOSTS = [
  "bit.ly", "tinyurl.com", "t.co", "is.gd", "goo.gl", "cutt.ly", "rb.gy", "t.ly", "shorturl.at",
  "raw.githubusercontent.com", "gist.githubusercontent.com", "objects.githubusercontent.com",
  "pastebin.com", "paste.ee", "hastebin.com", "ghostbin.co", "transfer.sh", "file.io", "0x0.st", "temp.sh",
  "webhook.site", "requestbin.net", "pipedream.net", "ngrok.io", "ngrok-free.app", "ngrok.app",
  "trycloudflare.com", "serveo.net", "loca.lt", "interact.sh", "oast.fun", "burpcollaborator.net",
]
  .map((h) => h.replace(/\./g, "\\."))
  .join("|");

/* Not part of a longer path, URL, email address or dotted name. */
const START = "(?<![\\w@./:\\\\-])";
/* The name ends here (a trailing full stop is fine). */
const END = "(?::\\d{2,5})?(?![\\w-]|\\.[\\w-])";

const WITH_PATH_RE = new RegExp(
  `${START}(?:${LABEL}\\.)+(?:${TLDS})(?::\\d{2,5})?\\/[^\\s)>\\]"'/]`,
  "i",
);
const WITH_PORT_RE = new RegExp(`${START}(?:${LABEL}\\.)+(?:${TLDS}):\\d{2,5}(?![\\w.])`, "i");
const WWW_RE = new RegExp(`${START}www\\.(?:${LABEL}\\.)+(?:${TLDS})${END}`, "i");
const KNOWN_HOST_RE = new RegExp(`${START}(?:${LABEL}\\.)*(?:${KNOWN_HOSTS})${END}`, "i");
const HOST_NAME_RE = new RegExp(`${START}(?:${LABEL}\\.)+(?:${TLDS})${END}`, "i");

/* `0\d{1,3}`: a leading zero (`04`, `0177`), which curl and inet_aton read as octal. */
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d|0\\d{1,3})";
const IPV4 = `${OCTET}(?:\\.${OCTET}){3}`;
/* `/0` to `/32` with nothing after it (a full stop is fine): a CIDR prefix length. */
const CIDR_SUFFIX = "\\/(?:3[0-2]|[12]?\\d)(?![\\w\\/-]|\\.[\\w-])";
const NOT_VERSION = "(?<!\\b(?:version|ver|build|release|v)\\s*)";
const IP_WITH_PATH_RE = new RegExp(`${START}${IPV4}(?!${CIDR_SUFFIX})(?::\\d{1,5})?\\/[^\\s)>\\]"'/]`, "i");
const IP_WITH_PORT_RE = new RegExp(`${START}${IPV4}:\\d{1,5}(?![\\w.])`, "i");
const PUNYCODE_RE = new RegExp(`${START}(?=(?:[a-z0-9-]*\\.)*xn--)(?:${LABEL}\\.)+${LABEL}${END}`, "i");
const BARE_IP_RE = new RegExp(`${START}${NOT_VERSION}${IPV4}(?![\\w\\/-]|\\.[\\w-]|:\\d)`, "i");
/*
 * For hasHostName only: an IPv4 address followed by `/` and anything at all
 * (nothing, a path, a CIDR length). `1.2.3.4/8` may be a path as well as a
 * range, and `1.2.3.4/` is the server root.
 */
const IP_SLASH_RE = new RegExp(`${START}${NOT_VERSION}${IPV4}(?::\\d{1,5})?\\/`, "i");
/*
 * For hasHostName only: the 2- and 3-part short forms (`127.1` is
 * 127.0.0.1) with a port, or with a path that starts with a non-digit, so a
 * fraction or a version range (`1.5/2`, `3.12/3.13`) is not a host.
 */
const SHORT_IP_RE = new RegExp(
  `${START}${NOT_VERSION}${OCTET}(?:\\.${OCTET})?\\.\\d{1,8}(?::\\d{1,5}(?![\\w.])|\\/[^\\s\\d)>\\]"'/.])`,
  "i",
);

/** The first host-like token without a scheme, or null. */
export function findBareHost(text: string): { index: number; host: string } | null {
  let best: RegExpExecArray | null = null;
  for (const re of [WITH_PATH_RE, WITH_PORT_RE, WWW_RE, KNOWN_HOST_RE, IP_WITH_PATH_RE, IP_WITH_PORT_RE, PUNYCODE_RE]) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) best = m;
  }
  if (best === null) return null;
  const token = text.slice(best.index).match(/^[^\s/:)>\]"']+/)?.[0] ?? best[0];
  return { index: best.index, host: token.replace(/\.$/, "") };
}

export function hasBareHost(text: string): boolean {
  return findBareHost(text) !== null;
}

/** A plain host name (`attacker.com`), path or not. Only for rules that also need other signals. */
export function hasHostName(text: string): boolean {
  return (
    hasBareHost(text)
    || HOST_NAME_RE.test(text)
    || BARE_IP_RE.test(text)
    || IP_SLASH_RE.test(text)
    || SHORT_IP_RE.test(text)
  );
}
