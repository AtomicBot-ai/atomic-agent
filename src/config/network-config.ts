import { parseBool } from "./config-primitives.js";
import { ConfigValidationError } from "./config-validation-error.js";

/**
 * `network` block of config.json (unversioned, additive, ATO-1084).
 *
 * - `offline` (default `false`): the network kill switch. When `true`
 *   the agent refuses every outbound connection whose host is not this
 *   machine (`localhost`, `127.0.0.0/8`, `::1`): the process-wide HTTP
 *   pool, the web/HTTP tools, the browser tools, remote MCP servers,
 *   subscription CLI providers, the Telegram bot and anonymous
 *   analytics / crash reports. Local models keep working. Env
 *   `ATOMIC_AGENT_OFFLINE=1` turns it on for one process whatever the
 *   file says; neither can be turned off for a process already running.
 *   Shell commands and stdio MCP servers are separate programs and are
 *   not network-isolated (see src/llm/docs/offline-network.md).
 * - `proxy` (ATO-87): the user's own HTTP(S) proxy or VPN client port
 *   for the agent's web traffic. See `NetworkProxyConfig`.
 */
/** Env switch: `1` / `true` / `yes` / `on` turns offline mode on for the process. */
export const OFFLINE_ENV = "ATOMIC_AGENT_OFFLINE";

/** Env override of `network.proxy.url`: wins over the file for one process. */
export const PROXY_ENV = "ATOMIC_AGENT_PROXY";

/** Schemes `network.proxy.url` accepts. SOCKS is not one (see below). */
export const PROXY_SCHEMES: readonly string[] = ["http:", "https:"];

/**
 * The user's own proxy for the agent's web traffic (ATO-87): model
 * providers, web search, `os.web.*` / `os.http.request` (curl), remote
 * MCP servers and the browser the agent starts. For a network where a
 * provider or a search engine is unreachable, or a VPN client that
 * exposes a local HTTP port (v2ray, Clash, sing-box, Outline do).
 *
 * - `url` (default `null`, off): `http://host:port` or `https://host:port`,
 *   with `user:password@` when the proxy needs it. SOCKS is refused with a
 *   hint to use the client's HTTP port, as Claude Code does.
 * - `noProxy` (default `[]`): hosts that go direct, curl / `NO_PROXY`
 *   style (`example.com` also covers its subdomains). This machine
 *   (`localhost`, `127.0.0.1`, `::1`) always goes direct.
 *
 * Env `ATOMIC_AGENT_PROXY` sets `url` for one process. Offline mode wins
 * over a proxy: nothing is sent at all.
 */
export interface NetworkProxyConfig {
  /** Your own HTTP(S) proxy for the agent's web traffic (ATO-87), `http://host:port` or `https://host:port`, with `user:password@` if needed; `null` is off. `ATOMIC_AGENT_PROXY` sets it for one process. */
  url: string | null;
  /** Hosts that bypass `network.proxy.url` (`example.com` also covers its subdomains). This machine always goes direct. */
  noProxy: string[];
}

export interface NetworkConfig {
  offline: boolean;
  proxy: NetworkProxyConfig;
}

export function createNetworkDefaults(): NetworkConfig {
  return { offline: false, proxy: { url: null, noProxy: [] } };
}

/**
 * Check one proxy URL and return it trimmed. Throws `ConfigValidationError`
 * naming `field`; the message never repeats a password.
 */
export function parseProxyUrl(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new ConfigValidationError(`${field} must be a proxy URL like http://127.0.0.1:8080`);
  }
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigValidationError(`${field} is not a URL (expected http://host:port)`);
  }
  if (url.protocol.startsWith("socks")) {
    throw new ConfigValidationError(
      `${field}: SOCKS proxies are not supported; use the HTTP port of your proxy or VPN client`,
    );
  }
  if (!PROXY_SCHEMES.includes(url.protocol)) {
    throw new ConfigValidationError(`${field} must start with http:// or https://`);
  }
  if (url.hostname.length === 0) {
    throw new ConfigValidationError(`${field} has no host`);
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new ConfigValidationError(`${field} must be only scheme://host:port`);
  }
  return value;
}

function parseNoProxy(raw: unknown, field: string): string[] {
  const list = typeof raw === "string" ? raw.split(",") : raw;
  if (!Array.isArray(list)) {
    throw new ConfigValidationError(`${field} must be a list of host names`);
  }
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") {
      throw new ConfigValidationError(`${field} must be a list of host names`);
    }
    const host = item.trim().toLowerCase();
    if (host.length === 0) continue;
    if (/[\s/;]/.test(host)) {
      throw new ConfigValidationError(`${field}: "${host}" is not a host name`);
    }
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

export function parseNetworkProxyConfig(
  raw: unknown,
  defaults: NetworkProxyConfig,
): NetworkProxyConfig {
  if (raw === undefined || raw === null) {
    return { url: defaults.url, noProxy: [...defaults.noProxy] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError("network.proxy must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const rawUrl = obj.url ?? defaults.url;
  return {
    url: rawUrl === null || rawUrl === "" ? null : parseProxyUrl(rawUrl, "network.proxy.url"),
    noProxy: parseNoProxy(obj.noProxy ?? defaults.noProxy, "network.proxy.noProxy"),
  };
}

export function parseNetworkConfig(
  raw: Record<string, unknown>,
  readDefaults: () => NetworkConfig,
): NetworkConfig {
  const defaults = readDefaults();
  return {
    offline: parseBool(raw.offline ?? defaults.offline, "network.offline"),
    proxy: parseNetworkProxyConfig(raw.proxy, defaults.proxy),
  };
}
