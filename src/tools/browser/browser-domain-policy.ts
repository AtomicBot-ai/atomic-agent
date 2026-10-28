/**
 * Operator domain lists for the browser tools (`browser.blockedDomains`,
 * `browser.allowedDomains` in config.json). A blocked host is refused at
 * every approval level; with a non-empty allow-list, a host outside it
 * asks first (`browser_offsite`). Matching is by host: an entry matches
 * itself and every subdomain, case-insensitively.
 */
export interface BrowserDomainPolicy {
  readonly blockedDomains: readonly string[];
  readonly allowedDomains: readonly string[];
}

export const EMPTY_DOMAIN_POLICY: BrowserDomainPolicy = {
  blockedDomains: [],
  allowedDomains: [],
};

/**
 * `"https://*.Example.com/path"` → `"example.com"`. Strips a scheme,
 * user info, path / query / fragment, port, a leading `*.` or `.`, and
 * a trailing dot. `null` for an entry with nothing left.
 */
export function normalizeDomainEntry(raw: string): string | null {
  let entry = raw.trim().toLowerCase();
  entry = entry.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  entry = entry.split(/[/?#]/, 1)[0] ?? "";
  const at = entry.lastIndexOf("@");
  if (at >= 0) entry = entry.slice(at + 1);
  entry = entry.replace(/:\d*$/, "");
  entry = entry.replace(/^(\*\.)+/, "").replace(/^\.+/, "").replace(/\.+$/, "");
  return entry.length > 0 ? entry : null;
}

/** Lowercased host without a trailing dot. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, "");
}

/** `host` equals `entry` or is a subdomain of it. `entry` is normalised. */
export function hostMatchesDomain(host: string, entry: string): boolean {
  const h = normalizeHost(host);
  return h === entry || h.endsWith(`.${entry}`);
}

export function hostMatchesAny(host: string, entries: readonly string[]): boolean {
  for (const raw of entries) {
    const entry = normalizeDomainEntry(raw);
    if (entry !== null && hostMatchesDomain(host, entry)) return true;
  }
  return false;
}

/** Host of an http(s) URL, or `null` for anything else / unparseable. */
export function webHostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.length > 0 ? normalizeHost(parsed.hostname) : null;
  } catch {
    return null;
  }
}

export type DomainVerdict =
  | { kind: "ok"; host: string | null }
  | { kind: "blocked"; host: string }
  | { kind: "offsite"; host: string };

/**
 * Where a navigation to `url` stands. Non-web URLs have no host here and
 * come back `ok`: their own gate (`browser_nonweb`) handles them.
 */
export function checkBrowserUrl(url: string, policy: BrowserDomainPolicy): DomainVerdict {
  const host = webHostOf(url);
  if (host === null) return { kind: "ok", host: null };
  return checkBrowserHost(host, policy);
}

/**
 * The first blocked host among a page and the frames it embeds, or
 * `null`. A snapshot or screenshot shows iframe content too, so an
 * allowed page framing a blocked site is refused as a whole.
 */
export function blockedHostOfPage(
  url: string,
  frameUrls: readonly string[] | undefined,
  policy: BrowserDomainPolicy,
): string | null {
  if (policy.blockedDomains.length === 0) return null;
  for (const candidate of [url, ...(frameUrls ?? [])]) {
    const verdict = checkBrowserUrl(candidate, policy);
    if (verdict.kind === "blocked") return verdict.host;
  }
  return null;
}

export function checkBrowserHost(host: string, policy: BrowserDomainPolicy): DomainVerdict {
  if (hostMatchesAny(host, policy.blockedDomains)) return { kind: "blocked", host };
  const allowed = policy.allowedDomains.filter((d) => normalizeDomainEntry(d) !== null);
  if (allowed.length > 0 && !hostMatchesAny(host, allowed)) return { kind: "offsite", host };
  return { kind: "ok", host };
}

/** Tool-result text for a refused (blocked) host. */
export function blockedDomainMessage(tool: string, host: string): string {
  return (
    `${tool} was not run: ${host} is in browser.blockedDomains, so the browser ` +
    "may not open or act on it at any approval level. Do not try another way to reach it; " +
    "tell the user the site is blocked in their settings."
  );
}
