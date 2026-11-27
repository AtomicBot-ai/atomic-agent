/**
 * ATO-2797: the redirect walk behind `@https://...` (mention-url.ts).
 *
 * Redirects are followed by hand, never by `redirect: "follow"`, so every
 * hop is judged before anything connects to it. For a public link each hop's
 * host is resolved and checked with the web tools' SSRF guard
 * (`assertHostAllowed`: any private, loopback, link-local or metadata
 * address refuses the hop), and the connection is then pinned to exactly the
 * addresses that were checked, so a second DNS answer cannot swap in a local
 * one (DNS rebinding). The same rules `os.web.fetch` and `os.http.request`
 * apply with curl's `--resolve`.
 *
 * A link the person typed as local (`@http://localhost:3000`, or a name that
 * resolves to this network, like an intranet wiki) is on purpose and is read
 * as before, redirects included.
 *
 * With a proxy (`network.proxy` or the proxy variables) the proxy makes the
 * connection, so each hop is still checked by name but not pinned: the
 * agent's proxy settings stay in force, as they do for curl.
 */

import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import { currentAgentProxy } from "../llm/agent-proxy.js";
import { offlineRefusal } from "../llm/offline-network.js";
import { proxyConfigured } from "../llm/transport-deadlines.js";
import { assertHostAllowed, SsrfBlockedError } from "../tools/os/web/web-fetch-ssrf-guard.js";
import { isLocalHost } from "./mention-hosts.js";

/** Raised for an answer that is read but not used: the reason goes in the block. */
export class UrlSkip extends Error {}

export const MAX_URL_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Resolve and check one hop's host; the safe addresses to connect to, or `SsrfBlockedError`. */
export type VetHost = (url: URL) => Promise<readonly string[]>;
export const defaultVetHost: VetHost = (url) => assertHostAllowed(url);

/**
 * `fetch` with undici's `dispatcher` option. Node's built-in `fetch` refuses
 * a dispatcher from the undici package (see transport-deadlines.ts), so the
 * default is undici's own `fetch`; without a dispatcher it uses the same
 * process-wide pool (proxy, offline guard) as every other request.
 */
export type FetchLike = (url: string, init: RequestInit & { dispatcher?: Dispatcher }) => Promise<Response>;
export const defaultFetch = undiciFetch as unknown as FetchLike;

export interface HopOptions {
  fetchImpl: FetchLike;
  vetHost: VetHost;
  signal: AbortSignal;
  headers: Record<string, string>;
}

export interface FinalAnswer {
  res: Response;
  /** Close the hop's pinned pool once the body is read. */
  release: () => void;
}

/** Answer node's `lookup` with the checked addresses only. */
export function pinnedLookup(addresses: readonly string[]): LookupFunction {
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));
  return ((_host: string, options: unknown, callback?: unknown) => {
    const cb = (typeof options === "function" ? options : callback) as (...args: unknown[]) => void;
    const opts = (typeof options === "object" && options !== null ? options : {}) as { all?: boolean; family?: unknown };
    const family = opts.family === 4 || opts.family === "IPv4" ? 4 : opts.family === 6 || opts.family === "IPv6" ? 6 : 0;
    const list = family === 0 ? entries : entries.filter((e) => e.family === family);
    const first = list[0];
    if (first === undefined) {
      cb(Object.assign(new Error("no checked address for this host"), { code: "ENOTFOUND" }));
      return;
    }
    if (opts.all) cb(null, list);
    else cb(null, first.address, first.family);
  }) as LookupFunction;
}

function canPin(): boolean {
  return currentAgentProxy() === null && !proxyConfigured(process.env);
}

function blockedReason(err: SsrfBlockedError): string {
  return /private\/internal/.test(err.message) ? "redirected to a local address" : "could not be fetched";
}

/**
 * The typed link's own addresses, or `null` when the person typed a local
 * link (by its text, or a name that resolves to this network).
 */
async function startOf(url: URL, vetHost: VetHost): Promise<readonly string[] | null> {
  if (isLocalHost(url.hostname)) return null;
  try {
    return await vetHost(url);
  } catch (err) {
    // A typed name on this network, or one that does not resolve: the read
    // goes ahead as typed and the network says what happens.
    if (err instanceof SsrfBlockedError) return null;
    throw err;
  }
}

/** Fetch `url`, following up to MAX_URL_REDIRECTS redirects, each checked before it connects. */
export async function fetchCheckedHops(url: string, o: HopOptions): Promise<FinalAnswer> {
  let current = new URL(url);
  const start = await startOf(current, o.vetHost);
  const onPurpose = start === null;
  for (let hop = 0; ; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") throw new UrlSkip("redirected away from http");
    if (hop > 0 && offlineRefusal(current.href, "@link") !== null) throw new UrlSkip("offline mode is on");
    let pool: Agent | undefined;
    if (!onPurpose) {
      let addresses: readonly string[];
      try {
        addresses = hop === 0 && start !== null ? start : await o.vetHost(current);
      } catch (err) {
        if (err instanceof SsrfBlockedError) throw new UrlSkip(blockedReason(err));
        throw err;
      }
      if (canPin()) pool = new Agent({ connect: { lookup: pinnedLookup(addresses) } });
    }
    const release = (): void => { void pool?.destroy().catch(() => undefined); };
    let res: Response;
    try {
      res = await o.fetchImpl(current.href, {
        signal: o.signal,
        redirect: "manual",
        headers: o.headers,
        ...(pool ? { dispatcher: pool } : {}),
      });
    } catch (err) {
      release();
      throw err;
    }
    const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get("location") : null;
    if (location === null) return { res, release };
    await res.body?.cancel().catch(() => undefined);
    release();
    if (hop >= MAX_URL_REDIRECTS) throw new UrlSkip("too many redirects");
    try {
      current = new URL(location, current);
    } catch {
      throw new UrlSkip("redirected to a broken link");
    }
  }
}
