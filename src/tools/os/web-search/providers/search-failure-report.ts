import {
  EXA_GET_KEY_URL,
  WebSearchRateLimitedError,
  type WebSearchKeyRequired,
} from "../web-search-errors.js";

/**
 * Plain-words report for a search that no provider answered (ATO-325).
 *
 * Before it the tool's error was whichever provider failed first, verbatim:
 * a bare `curl: (28) Connection timed out after 15005 milliseconds` that
 * named neither the provider nor anything the user could do about it.
 */

/**
 * curl and DNS failures that mean the host was never reached: no DNS
 * answer (exit 6), a refused connection (7), a TCP connect or name lookup
 * that ran out the connect timeout (28), a TLS handshake that failed (35).
 * Matched on the message because that is all a transport throw carries.
 * A total-time timeout (exit 28 `Operation timed out`) is not one: the
 * host answered the handshake and then was slow.
 */
const CONNECT_FAILURE =
  /curl: \((?:6|7|35)\)|could not resolve host|failed to connect|connection timed out|connection refused|resolving timed out|DNS resolution failed/i;

/** Any other curl timeout (exit 28): the host took too long to answer. */
const TIMEOUT_FAILURE = /curl: \(28\)|timed out/i;

export function isConnectFailure(err: unknown): boolean {
  return CONNECT_FAILURE.test(errorMessage(err));
}

const DNS_FAILURE =
  /curl: \(6\)|could not resolve host|DNS resolution failed|resolving timed out/i;

/**
 * What a connect failure was, in words (ATO-315): `curl: (28) Connection
 * timed out after 5002 milliseconds` reads to a user as nothing at all.
 * Order matters: a lookup that timed out is a DNS problem, not exit 28's
 * generic "timed out".
 */
function connectReason(raw: string): string {
  if (DNS_FAILURE.test(raw)) {
    return "the site's name could not be looked up (DNS)";
  }
  if (/curl: \(35\)/i.test(raw)) {
    return "the secure connection (TLS) failed";
  }
  if (/connection timed out|curl: \(28\)/i.test(raw)) {
    const seconds = timeoutSeconds(raw);
    return seconds === undefined
      ? "the connection timed out"
      : `the connection timed out after ${seconds} s`;
  }
  return "the connection was refused";
}

/** `after 5002 milliseconds` (or `ms`) -> `5`; undefined when not said. */
function timeoutSeconds(raw: string): number | undefined {
  const match = /after (\d+) (?:milliseconds|ms)\b/i.exec(raw);
  if (!match) return undefined;
  return Math.round(Number(match[1]) / 1000);
}

/**
 * One line per failed provider, `"<name>: <what happened>"`. The raw
 * message is kept after the plain words, for whoever has to debug it.
 */
export function describeFailure(
  name: string,
  err: unknown,
  keylessExa: boolean,
): string {
  const raw = errorMessage(err);
  if (err instanceof WebSearchRateLimitedError) {
    return keylessExa
      ? `${name}: free limit reached (HTTP 429)`
      : `${name}: rate limited (HTTP 429)`;
  }
  if (isConnectFailure(err)) {
    return (
      `${name}: could not connect, ${connectReason(raw)} ` +
      `(site unreachable from this network); ${raw}`
    );
  }
  if (TIMEOUT_FAILURE.test(raw)) {
    const seconds = timeoutSeconds(raw);
    const inTime = seconds === undefined ? "in time" : `in ${seconds} s`;
    return `${name}: timed out (connected, but no answer ${inTime}); ${raw}`;
  }
  return `${name}: ${raw}`;
}

/**
 * The tool's error text: what failed, one action, and what the model
 * should do now. The last line is there because a model that only sees
 * "search failed" tends to rephrase the query and pay the same timeouts
 * again; told that search is out, it answers without it.
 */
export function buildUnavailableMessage(input: {
  failures: readonly string[];
  keyRequired: WebSearchKeyRequired | undefined;
  allUnreachable: boolean;
}): string {
  const lines = [
    "Web search is unavailable: no search provider answered.",
    ...input.failures.map((line) => `- ${line}`),
  ];
  if (input.allUnreachable) {
    lines.push(
      "None of the search sites could be reached: check the internet connection, VPN or proxy.",
    );
  }
  if (input.keyRequired) {
    const envVar = input.keyRequired.envVar;
    lines.push(
      `To fix it: get a free Exa API key at ${EXA_GET_KEY_URL} and add it. ` +
        "In the desktop app, paste it into the key card in the chat or in Settings. " +
        `In the terminal, add \`${envVar}=...\` to the agent's .env file ` +
        "(~/.atomic-agent/.env, or $ATOMIC_AGENT_STATE_DIR/.env) and restart the agent. " +
        "Or set `web.search.provider` to `brave` (with its API key) or `searxng` (with your own instance).",
    );
  } else {
    lines.push(
      "To fix it: check the network, or choose another provider in `web.search.provider`: " +
        "`brave` (with its API key in the env) or `searxng` (with `web.search.searxng.instanceUrl`).",
    );
  }
  lines.push(
    "Do not repeat this search. Answer without web search and tell the user that web search is not available right now.",
  );
  return lines.join("\n");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
