import { isIP } from "node:net";
import type { Dispatcher } from "undici";

import { OFFLINE_ENV } from "../config/network-config.js";

/**
 * Offline mode: the agent's network kill switch (ATO-1084).
 *
 * While it is on, every outbound connection whose host is not this
 * machine is refused: `localhost`, `127.0.0.0/8` and `::1` stay
 * reachable (local models, the managed llama-server, a local MCP server
 * on http), everything else fails with `offline mode: <host> blocked`.
 *
 * Where it is enforced:
 *  - the process-wide undici dispatcher (`offlineNetworkInterceptor`,
 *    composed by `installTransportDeadlines`), which is every `fetch` in
 *    the process: cloud providers, model downloads, update checks, skill
 *    and plugin hubs, analytics and crash reports, remote MCP servers;
 *  - tools that run another program or bypass `fetch` check
 *    `offlineRefusal` themselves before anything is sent: `os.web.*`,
 *    `os.http.request` (curl), the browser tools (Chrome), subscription
 *    CLI providers and the Telegram bot (grammy's own HTTP client).
 *
 * Not enforced, and not claimed: shell commands, git, stdio MCP servers
 * and any other child process the user asks for. Without an OS sandbox
 * nothing in this process can stop another program from opening a
 * socket. See docs/offline-network.md.
 *
 * Process-wide on purpose: it lives with the dispatcher it guards,
 * which is itself one global (see `installTransportDeadlines`). The
 * flag is read at dispatch time, so turning the mode on or off applies
 * to the next request without reinstalling the pool.
 */

const ON_VALUES = new Set(["1", "true", "yes", "on"]);

/** True when `ATOMIC_AGENT_OFFLINE` asks for offline mode. */
export function isOfflineRequestedByEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[OFFLINE_ENV];
  return typeof raw === "string" && ON_VALUES.has(raw.trim().toLowerCase());
}

/** What the counters report (the shape the offline-mode UI reads). */
export interface EgressSnapshot {
  /** Request bytes (target path + body) sent to non-loopback hosts. */
  bytesOut: number;
  /** Requests to non-loopback hosts that were let through. */
  requestsOut: number;
  /** Attempts offline mode refused. */
  requestsBlocked: number;
  /** ISO time the counters start from; reset when offline mode turns on. */
  since: string;
}

let enabledBySetting = false;
let bytesOut = 0;
let requestsOut = 0;
let requestsBlocked = 0;
let since = new Date();

/**
 * Turn offline mode on or off for this process (config `network.offline`,
 * the TUI / desktop toggle). Turning it on resets the counters, so they
 * then read "since offline mode went on". `ATOMIC_AGENT_OFFLINE=1` keeps
 * it on whatever this is told.
 */
export function setOfflineNetwork(enabled: boolean): void {
  const wasOn = isOfflineNetwork();
  enabledBySetting = enabled;
  if (!wasOn && isOfflineNetwork()) resetEgressCounters();
}

/** Is offline mode on for this process right now? */
export function isOfflineNetwork(env: NodeJS.ProcessEnv = process.env): boolean {
  return enabledBySetting || isOfflineRequestedByEnv(env);
}

/** Outbound traffic counters for this process. Cheap; never throws. */
export function egressSnapshot(): EgressSnapshot {
  return {
    bytesOut,
    requestsOut,
    requestsBlocked,
    since: since.toISOString(),
  };
}

function resetEgressCounters(): void {
  bytesOut = 0;
  requestsOut = 0;
  requestsBlocked = 0;
  since = new Date();
}

/** Test seam: offline off (env aside), counters zeroed. */
export function resetOfflineNetworkForTests(): void {
  enabledBySetting = false;
  resetEgressCounters();
}

/**
 * Is `host` this machine? `localhost`, any `127.x.x.x`, `::1` (and the
 * IPv4-mapped `::ffff:127.x.x.x`), brackets and a trailing dot allowed.
 * `*.localhost` is not: whether it resolves locally depends on the OS
 * resolver, and asking a DNS server about it is already traffic.
 */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase().replace(/\.+$/, "");
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "localhost") return true;
  const family = isIP(h);
  if (family === 4) return h.startsWith("127.");
  if (family !== 6) return false;
  let v6: string;
  try {
    v6 = new URL(`http://[${h}]/`).hostname.slice(1, -1);
  } catch {
    return false;
  }
  return v6 === "::1" || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(v6);
}

/** Host of a URL (string or `URL`), or `null` when it does not parse. */
export function hostOfUrl(target: string | URL): string | null {
  try {
    const url = typeof target === "string" ? new URL(target) : target;
    return url.hostname.length > 0 ? url.hostname : null;
  } catch {
    return null;
  }
}

export const OFFLINE_ERROR_CODE = "ATOMIC_AGENT_OFFLINE";

/** The one refusal every enforcement point raises or reports. */
export class OfflineNetworkError extends Error {
  readonly code = OFFLINE_ERROR_CODE;
  readonly host: string;

  constructor(host: string, what?: string) {
    super(offlineBlockedMessage(host, what));
    this.name = "OfflineNetworkError";
    this.host = host;
  }
}

export function offlineBlockedMessage(host: string, what?: string): string {
  const subject = what ? `${what}: ` : "";
  return (
    `${subject}offline mode: ${host} blocked. ` +
    "Only this machine (localhost, 127.0.0.0/8, ::1) is reachable while " +
    "offline mode is on (config network.offline or ATOMIC_AGENT_OFFLINE)."
  );
}

/**
 * The refusal for a request to `target`, or `null` when it may go:
 * offline mode is off, or the host is this machine. A refusal counts in
 * `requestsBlocked`. An unparseable target is refused while offline.
 */
export function offlineRefusal(
  target: string | URL,
  what?: string,
): OfflineNetworkError | null {
  if (!isOfflineNetwork()) return null;
  const host = hostOfUrl(target);
  if (host !== null && isLoopbackHost(host)) return null;
  requestsBlocked += 1;
  return new OfflineNetworkError(host ?? String(target), what);
}

/**
 * Refuse a whole remote-only capability (a cloud CLI, the Telegram bot)
 * while offline. `host` names where it would have gone.
 */
export function offlineRefusalFor(
  host: string,
  what?: string,
): OfflineNetworkError | null {
  if (!isOfflineNetwork() || isLoopbackHost(host)) return null;
  requestsBlocked += 1;
  return new OfflineNetworkError(host, what);
}

function originHost(origin: Dispatcher.DispatchOptions["origin"]): string | null {
  if (origin === undefined || origin === null) return null;
  return hostOfUrl(origin);
}

/**
 * undici interceptor for the global dispatcher. Loopback requests pass
 * untouched. Others are refused through the handler while offline, and
 * counted (`requestsOut`, `bytesOut`) when they are let through.
 */
export function offlineNetworkInterceptor(): Dispatcher.DispatcherComposeInterceptor {
  return (dispatch) =>
    function offlineNetworkGuard(opts, handler) {
      const host = originHost(opts.origin);
      if (host !== null && isLoopbackHost(host)) return dispatch(opts, handler);
      if (isOfflineNetwork()) {
        requestsBlocked += 1;
        const err = new OfflineNetworkError(host ?? "unknown host");
        if (typeof handler.onResponseError !== "function") throw err;
        handler.onResponseError(
          null as unknown as Dispatcher.DispatchController,
          err,
        );
        return false;
      }
      if (host === null) return dispatch(opts, handler);
      requestsOut += 1;
      bytesOut += Buffer.byteLength(opts.path ?? "");
      return dispatch(opts, countingHandler(handler));
    };
}

/**
 * The same handler, with body bytes counted as undici writes them. Every
 * other member is the target's own, bound to it (undici's handlers keep
 * private fields, which a Proxy receiver cannot reach).
 */
function countingHandler(
  handler: Dispatcher.DispatchHandler,
): Dispatcher.DispatchHandler {
  return new Proxy(handler, {
    get(target, key) {
      if (key === "onBodySent") {
        return (chunk: Buffer | string) => {
          bytesOut +=
            typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
          return target.onBodySent?.(chunk as Buffer);
        };
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
