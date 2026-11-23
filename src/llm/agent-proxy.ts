import type { NetworkProxyConfig } from "../config/network-config.js";

/**
 * The user's own proxy for the agent's web traffic (ATO-87), as this
 * process applies it.
 *
 * One process-wide value, set by `installTransportDeadlines` from the
 * config it is handed, for the same reason offline mode is one: the
 * undici dispatcher it feeds is itself one global. Three places read it:
 *
 *  - the `fetch` pool (`transport-deadlines.ts`): model providers, web
 *    search, remote MCP servers, hubs and downloads;
 *  - `runCurl`: `os.web.*` and `os.http.request`, through curl's own
 *    proxy variables, so the password is never on a command line;
 *  - the Chrome the agent starts (`--proxy-server`).
 *
 * Not covered, and not claimed: shell commands and other programs the
 * agent runs, the user's own Chrome the agent attaches to (it keeps its
 * own proxy settings), and the Telegram bot's HTTP client.
 */
export interface AgentProxy {
  /** As configured, credentials included. Never logged or shown. */
  url: string;
  /** `scheme://host:port` without credentials: for Chrome and messages. */
  server: string;
  /** Hosts that go direct; always includes this machine. */
  noProxy: string[];
}

/** This machine always goes direct, whatever the list says. */
export const LOOPBACK_NO_PROXY: readonly string[] = ["localhost", "127.0.0.1", "::1"];

let current: AgentProxy | null = null;

/** Build the applied proxy from `network.proxy`, or `null` when it is off. */
export function agentProxyFrom(config: NetworkProxyConfig | undefined): AgentProxy | null {
  const raw = config?.url?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const noProxy = [...LOOPBACK_NO_PROXY];
  for (const host of config?.noProxy ?? []) {
    const h = host.trim().toLowerCase();
    if (h.length > 0 && !noProxy.includes(h)) noProxy.push(h);
  }
  return { url: raw, server: `${url.protocol}//${url.host}`, noProxy };
}

/** Apply (or clear, with `null`) the proxy for this process. */
export function setAgentProxy(proxy: AgentProxy | null): void {
  current = proxy;
}

/** The proxy this process sends web traffic through, if any. */
export function currentAgentProxy(): AgentProxy | null {
  return current;
}

/** Test seam. */
export function resetAgentProxyForTests(): void {
  current = null;
}

/** Same proxy, same list: the pool does not need rebuilding. */
export function sameAgentProxy(a: AgentProxy | null, b: AgentProxy | null): boolean {
  if (a === null || b === null) return a === b;
  return a.url === b.url && a.noProxy.join(",") === b.noProxy.join(",");
}

/** A proxy URL with the password replaced, for logs and messages. */
export function redactProxyUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password) url.password = "***";
    return `${url.protocol}//${url.username ? `${url.username}${url.password ? ":***" : ""}@` : ""}${url.host}`;
  } catch {
    return "(invalid proxy URL)";
  }
}

/**
 * Proxy variables for a curl child. curl reads `http_proxy` only in lower
 * case, `https_proxy` and `no_proxy` in either; both cases are set so an
 * inherited upper-case value cannot win. Returns `{}` when there is no
 * proxy, or when the caller's env already names one on purpose (the
 * verify sandbox points children at a dead proxy to cut the network):
 * that choice is left alone.
 */
export function curlProxyEnv(
  proxy: AgentProxy | null,
  childEnv: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  if (proxy === null) return {};
  if (childEnv && hasProxyVar(childEnv)) return {};
  const noProxy = proxy.noProxy.join(",");
  return {
    http_proxy: proxy.url,
    https_proxy: proxy.url,
    HTTPS_PROXY: proxy.url,
    no_proxy: noProxy,
    NO_PROXY: noProxy,
  };
}

function hasProxyVar(env: NodeJS.ProcessEnv): boolean {
  return ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"].some(
    (key) => typeof env[key] === "string" && env[key]!.length > 0,
  );
}

/**
 * Chrome flags for the browser the agent starts. Chrome ignores
 * credentials in `--proxy-server`, so a proxy that needs a password asks
 * for it in the browser window. Loopback is never proxied by Chrome.
 */
export function chromeProxyArgs(proxy: AgentProxy | null): string[] {
  if (proxy === null) return [];
  const args = [`--proxy-server=${proxy.server}`];
  const bypass = proxy.noProxy.filter((h) => !LOOPBACK_NO_PROXY.includes(h));
  if (bypass.length > 0) {
    // Chrome's list matches `example.com` exactly; `*.example.com` adds the
    // subdomains curl and undici already cover for the same entry.
    const rules = bypass.flatMap((h) => {
      const bare = h.replace(/^\*?\./, "");
      return [bare, `*.${bare}`];
    });
    args.push(`--proxy-bypass-list=${rules.join(";")}`);
  }
  return args;
}
