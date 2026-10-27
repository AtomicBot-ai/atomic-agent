import type { AtomicAgentConfig } from "../../../../config/index.js";
import {
  formatCooldown,
  type CooldownReason,
} from "../transport/provider-cooldown.js";
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
  if (/refused/i.test(raw)) return "the connection was refused";
  if (/network is unreachable|no route to host/i.test(raw)) {
    return "the network could not reach the site";
  }
  return "the connection failed";
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

/** The key card for keyless Exa (ATO-327). */
export function exaKeyRequired(
  reason: WebSearchKeyRequired["reason"],
  envVar: string,
): WebSearchKeyRequired {
  return { provider: "exa", reason, getKeyUrl: EXA_GET_KEY_URL, envVar };
}

/** What a keyless Exa failure says about asking for a key. */
export function keyReasonOf(err: unknown): WebSearchKeyRequired["reason"] {
  if (err instanceof WebSearchRateLimitedError) return "rate_limited";
  return isConnectFailure(err) ? "unreachable" : "missing";
}

/**
 * Why a chain provider could not be asked, for the all-failed report. Not
 * a switch over every name on purpose: a provider added later without a
 * case here still gets a sane line.
 */
export function describeUnusable(
  name: string,
  search: AtomicAgentConfig["web"]["search"],
): string {
  if (name === "brave") return `no ${search.brave.apiKeyEnv} set`;
  if (name === "searxng") return "no `web.search.searxng.instanceUrl` set";
  return "not configured";
}

/** Note and report line for a provider skipped because it is parked. */
export function parkedSkipLines(
  name: string,
  reason: CooldownReason,
  parkedMs: number,
  freeTier: boolean,
): { note: string; failure: string } {
  const wait = formatCooldown(parkedMs);
  if (reason === "unreachable") {
    return {
      note: `${name} skipped: could not connect a moment ago, retrying in ${wait}`,
      failure: `${name}: could not connect a moment ago (site unreachable from this network), next try in ${wait}`,
    };
  }
  const what = freeTier ? "free limit reached" : "rate limited";
  return {
    note: `${name} skipped: ${what}, retrying in ${wait}`,
    failure: `${name}: ${what}, next try in ${wait}`,
  };
}

/** Note for a provider just parked on a 429. */
export function rateLimitedNote(
  name: string,
  parkedMs: number,
  freeTier: boolean,
  envVar: string,
): string {
  const wait = formatCooldown(parkedMs);
  return freeTier
    ? `${name} free limit reached (HTTP 429, no ${envVar}), parked for ${wait}`
    : `${name} rate limited (HTTP 429), parked for ${wait}`;
}

/** Note for a provider just parked because its host was never reached. */
export function unreachableNote(
  name: string,
  parkedMs: number,
  raw: string,
): string {
  return `${name} could not connect, skipped for ${formatCooldown(parkedMs)}: ${raw}`;
}

/**
 * The tool's error text: what failed, a single "To fix it" line (the
 * free Exa key when one would help, otherwise the network or another
 * provider), and what the model should do now. The last line is there because a model that only sees
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
      "To fix it: check the network, or choose another provider in `web.search.provider`: " +
        "`brave` (with its API key in the env) or `searxng` (with `web.search.searxng.instanceUrl`).",
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

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
