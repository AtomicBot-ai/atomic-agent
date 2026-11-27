/**
 * Host helpers for the egress scan (ATO-2116): read the host out of a
 * URL, a scp-style `user@host:path` or a git remote, and decide whether
 * a host counts as known (loopback, `http.hostAllowlist`, a session
 * grant). Pure.
 */

/** A host as compared everywhere here: lower case, no trailing dots, no IPv6 brackets. */
export function normaliseHost(raw: string): string | null {
  let host = raw.trim().toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.length === 0 || host.length > 253) return null;
  // Letters, digits, dots, dashes, underscores; or an IPv6 literal. A `$`,
  // a quote or a brace means the host is built at run time: unknown.
  if (/^[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?$/.test(host)) return host;
  if (/^[0-9a-f:.]+$/.test(host) && host.includes(":")) return host;
  return null;
}

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Whether `word` starts with a `scheme://`. */
export function hasUrlScheme(word: string): boolean {
  return URL_SCHEME_RE.test(word);
}

/**
 * The host of `url` (`https://user@api.example.com:8443/x` gives
 * `api.example.com`), or `null`. Read by hand rather than with `URL`, so
 * a placeholder like `https://$HOST/x` comes out as unknown instead of a
 * percent-encoded look-alike.
 */
export function hostOfUrl(url: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]*)/i.exec(url.trim());
  if (match === null) return null;
  const authority = match[1] ?? "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPort.startsWith("[")) {
    const end = hostPort.indexOf("]");
    return end === -1 ? null : normaliseHost(hostPort.slice(0, end + 1));
  }
  return normaliseHost(hostPort.split(":")[0] ?? "");
}

/**
 * The host of a scp-style remote (`git@github.com:org/repo.git`,
 * `deploy@10.0.0.5:/srv`, `backup:/data`), or `null` when `word` is not
 * one: a local path, a `C:\` drive, a URL.
 */
export function hostOfScpTarget(word: string): string | null {
  if (hasUrlScheme(word) || word.startsWith("/") || word.startsWith(".")) return null;
  const match = /^(?:[^@/\s:]+@)?(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9_][A-Za-z0-9_.-]*):/.exec(word);
  if (match === null) return null;
  const host = match[1] ?? "";
  // `C:\dir` or `c:/dir` is a Windows drive, not a host.
  if (/^[A-Za-z]$/.test(host)) return null;
  return normaliseHost(host);
}

/**
 * The host a git remote URL points at, `"local"` for a path on this
 * machine (`/srv/repo.git`, `file://`, `../other`), or `null` when it
 * cannot be read.
 */
export function hostOfGitUrl(url: string): string | null | "local" {
  const value = url.trim();
  if (value.length === 0) return null;
  if (/^file:\/\//i.test(value)) return "local";
  if (hasUrlScheme(value)) return hostOfUrl(value);
  const scp = hostOfScpTarget(value);
  if (scp !== null) return scp;
  if (/^[./~]/.test(value) || /^[A-Za-z]:[\\/]/.test(value)) return "local";
  return null;
}

/** Hosts that stay on this machine. */
export function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * Whether `host` is on `allowlist` with the rules `http.hostAllowlist`
 * uses for `os.http.request`: exact, or `*.example.com` for the domain
 * and its subdomains. `null` (no list) covers nothing here: an unset list
 * means "any host" for the HTTP tool, not "every host is known".
 */
export function hostOnAllowlist(host: string, allowlist: readonly string[] | null): boolean {
  if (allowlist === null) return false;
  for (const entry of allowlist) {
    const rule = entry.trim().toLowerCase().replace(/\.+$/, "");
    if (rule.startsWith("*.")) {
      const base = rule.slice(2);
      if (base.length > 0 && (host === base || host.endsWith(`.${base}`))) return true;
    } else if (rule.length > 0 && rule === host) {
      return true;
    }
  }
  return false;
}
