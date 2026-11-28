/**
 * The egress hold (ATO-2116). A call whose command sends data to a host
 * nobody has said yes to is put to the person even where the level, a
 * session grant, a saved allow rule or bypass mode would run it
 * silently, and a fusion worker's fan-out scope does not cover it. It
 * only ever adds a prompt: a call that would prompt anyway prompts as
 * before.
 *
 * A host is known when it stays on this machine (`localhost`,
 * `127.0.0.1`, `::1`), is on `http.hostAllowlist` or on the durable
 * `agent.security.knownHosts` (ATO-2528), or the person already
 * said yes to it in this session: a per-site browser grant, an
 * "allow in this chat" on an HTTP request to it, or an
 * "allow in this chat" / "allow always" on an earlier command that sent
 * data to it (`ApprovalGate.resolve`). A destination whose host cannot
 * be read (`host: null`) is never known. Pure.
 */
import { hostOfUrl, hostOnAllowlist, isLoopbackHost } from "./egress-host.js";
import { outboundDestinations, type EgressDestination } from "./egress-scan.js";

export interface EgressKnownHosts {
  /** `http.hostAllowlist`; `null` (unset) makes no host known. */
  allowlist: readonly string[] | null;
  /** Hosts the person said yes to in this session, lower case. */
  sessionHosts: ReadonlySet<string>;
  /** `agent.security.knownHosts`: kept across sessions, same `*.domain` rules. */
  durableHosts?: readonly string[];
}

/** The outbound destinations of `egress` whose host is not known. */
export function unknownOutbound(
  egress: readonly EgressDestination[] | undefined,
  known: EgressKnownHosts,
): EgressDestination[] {
  return outboundDestinations(egress).filter((destination) => {
    const host = destination.host;
    if (host === null) return true;
    if (isLoopbackHost(host)) return false;
    if (hostOnAllowlist(host, known.allowlist)) return false;
    if (hostOnAllowlist(host, known.durableHosts ?? null)) return false;
    return !known.sessionHosts.has(host);
  });
}

/** The readable outbound hosts of `egress` that leave this machine, for "allow always" to keep. */
export function durableHostsToKeep(egress: readonly EgressDestination[] | undefined): string[] {
  const hosts = outboundDestinations(egress)
    .map((d) => d.host)
    .filter((h): h is string => h !== null && !isLoopbackHost(h));
  return [...new Set(hosts)];
}

/**
 * The host a key-narrowed session grant names, for
 * `EgressKnownHosts.sessionHosts`: the host of an HTTP grant's origin
 * (`https://api.example.com`). `null` for any other key (an MCP tool).
 */
export function hostOfGrantKey(key: string): string | null {
  return hostOfUrl(key);
}

/** The parts of a session's grant set the hold reads (`ApprovalGate.grantsBySession`). */
export interface EgressGrantView {
  /** Per-site browser grants, `"<category> <host>"` (`siteGrantKey`). */
  sites: ReadonlySet<string>;
  /** Key-narrowed category grants, `"<category>\0<key>"`. */
  scoped: ReadonlySet<string>;
}

/**
 * Hosts the person approved data going to, per session: remembered when
 * they answer a held command with a session grant or "allow always", and
 * dropped with the session's other grants. In memory only.
 */
export class EgressSessionHosts {
  private readonly bySession = new Map<string, Set<string>>();

  /** Remember the readable outbound hosts of `egress` for `sessionId`. */
  remember(sessionId: string, egress: readonly EgressDestination[] | undefined): void {
    const hosts = outboundDestinations(egress)
      .map((d) => d.host)
      .filter((h): h is string => h !== null);
    if (hosts.length === 0) return;
    let set = this.bySession.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.bySession.set(sessionId, set);
    }
    for (const host of hosts) set.add(host);
  }

  clear(sessionId?: string): void {
    if (sessionId === undefined) this.bySession.clear();
    else this.bySession.delete(sessionId);
  }

  /** Every host known for `sessionId`: remembered ones plus those its grants name. */
  known(sessionId: string, grants: EgressGrantView | undefined): Set<string> {
    const hosts = new Set(this.bySession.get(sessionId) ?? []);
    if (grants === undefined) return hosts;
    for (const key of grants.sites) {
      const host = key.slice(key.indexOf(" ") + 1);
      if (host.length > 0) hosts.add(host);
    }
    for (const id of grants.scoped) {
      const host = hostOfGrantKey(id.slice(id.indexOf("\u0000") + 1));
      if (host !== null) hosts.add(host);
    }
    return hosts;
  }
}

