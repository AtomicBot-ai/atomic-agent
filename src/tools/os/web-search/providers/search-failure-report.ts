import {
  EXA_GET_KEY_URL,
  WebSearchRateLimitedError,
  type WebSearchKeyHelp,
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
 * answer, a refused or timed out TCP/TLS handshake. Matched on the message
 * because that is all a transport throw carries.
 */
const CONNECT_FAILURE =
  /curl: \((?:6|7)\)|could not resolve host|failed to connect|connection timed out|connection refused|resolving timed out|DNS resolution failed/i;

/** Any other curl timeout (exit 28): the host took too long to answer. */
const TIMEOUT_FAILURE = /curl: \(28\)|timed out/i;

export function isConnectFailure(err: unknown): boolean {
  return CONNECT_FAILURE.test(errorMessage(err));
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
    return `${name}: could not connect (site unreachable from this network); ${raw}`;
  }
  if (TIMEOUT_FAILURE.test(raw)) {
    return `${name}: timed out (no answer in time); ${raw}`;
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
  /** Which "add a key" advice this process gives. Default `env-file`. */
  keyHelp?: WebSearchKeyHelp;
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
  if (input.keyRequired && input.keyHelp === "integrations-hub") {
    lines.push(integrationsHubKeyAdvice(input.keyRequired));
  } else if (input.keyRequired) {
    const envVar = input.keyRequired.envVar;
    lines.push(
      `To fix it: get a free Exa API key at ${EXA_GET_KEY_URL} and add it. ` +
        "In the desktop app, paste it into the key card in the chat or in Settings. " +
        `In the terminal, add \`${envVar}=...\` to the agent's .env file ` +
        "(~/.atomic-agent/.env, or $ATOMIC_AGENT_STATE_DIR/.env) and restart the agent.",
    );
  } else {
    lines.push(
      "To fix it: check the network, or choose another provider in `web.search.provider`.",
    );
  }
  lines.push(
    "Do not repeat this search. Answer without web search and tell the user that web search is not available right now.",
  );
  return lines.join("\n");
}

/**
 * The terminal UI's advice: its `/integrations` screen writes the key into
 * the running process, so there is no file to edit and no restart. "Ran
 * out" only when it did; an unreachable or failing free tier did not.
 */
function integrationsHubKeyAdvice(
  keyRequired: WebSearchKeyRequired,
): string {
  const action = `Open /integrations and add an Exa key (${keyRequired.getKeyUrl}).`;
  return keyRequired.reason === "rate_limited"
    ? `Free Exa searches ran out. ${action}`
    : `To fix it: ${action.charAt(0).toLowerCase()}${action.slice(1)}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
