import { isIP } from "node:net";

/**
 * The rules an API key must meet before `atomic-agent serve` runs with it
 * (ATO-760, ATO-1126, ATO-693). Moved out of serve-args.ts so a key read
 * from stdin after the parse (`--api-key-stdin`, ATO-2538) meets exactly
 * the same ones.
 */

/**
 * Why serve cannot run with `apiKey` (the operator's, or `null` for none),
 * or `null` when it can. Shared by the parse and by a key read from
 * stdin, so `--api-key-stdin` meets the same rules (ATO-2538).
 */
export function serveApiKeyError(
  apiKey: string | null,
  opts: { host: string; a2a: boolean; reapOnly: boolean; printApiKey: boolean },
): string | null {
  const { host } = opts;
  // A bearer header is trimmed before it is compared, so a key of only
  // whitespace could never be sent back: serve would start and refuse
  // every request.
  const servesNothing = opts.reapOnly || opts.printApiKey;
  if (!servesNothing && apiKey !== null && apiKey.trim().length === 0) {
    return "the API key is only whitespace (--api-key or ATOMIC_AGENT_API_KEY); set a real token";
  }
  if (!servesNothing && apiKey === null && !isLoopbackListenHost(host)) {
    return missingKeyOnNetworkError(host);
  }
  // ATO-1126: on the network the key is all that stands between a stranger and the agent's tools.
  if (!servesNothing && apiKey !== null && apiKey.length < MIN_NETWORK_KEY_LENGTH && !isLoopbackListenHost(host)) {
    return (
      `--host ${host} accepts connections from other machines, and an API key of ${apiKey.length} characters can be guessed. ` +
      `Use at least ${MIN_NETWORK_KEY_LENGTH} (for example: export ATOMIC_AGENT_API_KEY=$(openssl rand -hex 24)).`
    );
  }
  // ATO-693: A2A hands the agent and its tools to other programs; never without a key, even on loopback.
  if (!opts.reapOnly && opts.a2a && apiKey === null) {
    return (
      "--a2a lets other agents run tasks here and needs an API key: set --api-key <token> or ATOMIC_AGENT_API_KEY " +
      "(for example: export ATOMIC_AGENT_API_KEY=$(openssl rand -hex 24))"
    );
  }
  return null;
}

/** ATO-1126: the shortest API key serve takes on a network host. */
export const MIN_NETWORK_KEY_LENGTH = 16;

/**
 * Whether a `--host` value only accepts connections from this machine.
 * Decided from the literal alone, never by a DNS lookup:
 *  - `localhost` (and `localhost.`);
 *  - an IPv4 literal in 127/8, as `net.isIP` accepts it (dotted quad
 *    only, so shorthand such as `127.1` or `127.0.0.256` is not one);
 *  - the IPv6 loopback in any spelling (`::1`, `0:0:0:0:0:0:0:1`) and
 *    an IPv4-mapped 127/8 address (`::ffff:127.0.0.1`).
 * Everything else, `0.0.0.0`, `::`, a LAN address, a hostname or a
 * numeric string that is not an IP literal, counts as reachable from
 * other machines.
 */
export function isLoopbackListenHost(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (h === "localhost") return true;
  const kind = isIP(h);
  if (kind === 4) return h.split(".")[0] === "127";
  if (kind === 6) {
    // The URL parser prints the canonical compressed form, so every
    // spelling of one address compares equal. A zone id (`fe80::1%eth0`)
    // passes isIP but not the URL parser, and is never loopback.
    if (h.includes("%")) return false;
    const canonical = new URL(`http://[${h}]/`).hostname;
    return canonical === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(canonical);
  }
  return false;
}

/**
 * Whoever holds the key gets the agent and every tool it runs: shell
 * commands, file writes, the config file. On loopback serve falls back to
 * its own generated key (`serve-api-key.ts`); on a network host the parse
 * wants a key the operator chose and knows (ATO-760), so a machine never
 * opens to the network with a key nobody meant to hand out.
 */
function missingKeyOnNetworkError(host: string): string {
  return (
    `--host ${host} accepts connections from other machines, and whoever holds the API key ` +
    "can run the agent and its tools there. " +
    "Choose the key yourself with --api-key <token> or the ATOMIC_AGENT_API_KEY environment variable " +
    "(for example: export ATOMIC_AGENT_API_KEY=$(openssl rand -hex 24)), " +
    "or listen on 127.0.0.1"
  );
}
