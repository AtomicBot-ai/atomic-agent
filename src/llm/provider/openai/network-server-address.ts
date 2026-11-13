import { isLocalProviderUrl } from "../presets/is-local-provider-url.js";
import { isLocalServerUrl } from "./local-server-url.js";
import { normalizeOpenAiBaseUrl } from "./normalize-openai-base-url.js";

/**
 * ATO-1066: a model served by another computer on the operator's own
 * network (a desktop with a big GPU running llama-server, LM Studio or
 * Ollama with network serving on), used from this one through the
 * existing `openai-compatible` provider.
 *
 * Classification, on purpose: such a server is "your own hardware", not
 * a cloud service, but it is not "this machine" either.
 *  - `isLocalProviderUrl` (this machine only) does NOT include it. Its
 *    callers print "start the server on this computer" style advice and
 *    skip checks that only make sense for loopback; a box across the room
 *    needs different words.
 *  - `isLocalServerUrl` (this machine or the local network) does include
 *    it, as it already did, so chat-template arguments still go out.
 *  - A hand-made entry for it keeps the default `local` model mode
 *    (`defaultProviderModelMode`): it is not a known cloud host.
 *  - Its key is optional: a home server usually has none, but LM Studio
 *    and llama-server can be started with one.
 */

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Hostname of `url` without IPv6 brackets, lower-cased; `null` when unparsable. */
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

/**
 * `true` for a server on the local network that is not this machine:
 * RFC 1918 / link-local / unique-local addresses and `.local`, `.lan`,
 * `.internal`, `.home.arpa` or single-label names. Loopback (the whole
 * 127/8 block included) is this machine and answers `false`.
 */
export function isOtherComputerOnNetworkUrl(url: string | undefined): boolean {
  if (!url || !isLocalServerUrl(url) || isLocalProviderUrl(url)) return false;
  const host = hostnameOf(url);
  if (host === null) return false;
  return !host.startsWith("127.") && host !== "::1";
}

/**
 * Adds the scheme a typed base URL left out, so `new URL` reads the host
 * where it is: `192.168.1.20:8080` does not parse at all and
 * `gpu-box.local:1234` parses with `gpu-box.local:` as its scheme.
 * Servers on this machine or the home network get `http://` (llama-server,
 * LM Studio and Ollama serve plain HTTP); anything else gets `https://`.
 * Empty input stays empty so callers can still fall back to a default.
 */
export function withAssumedScheme(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || SCHEME.test(trimmed)) return trimmed;
  const asHttp = `http://${trimmed}`;
  return isLocalServerUrl(asHttp) ? asHttp : `https://${trimmed}`;
}

export type NetworkServerAddress =
  | { readonly ok: true; readonly baseUrl: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The address of a model server on another computer, as people read it
 * off that computer (`192.168.1.20:8080`, `gpu-box.local:1234`,
 * `http://10.0.0.5:11434/v1`), turned into the API root the compat
 * provider stores: scheme added (`http://` when none was typed), no query,
 * no trailing slash and no `/v1` (call sites append `/v1/...`).
 */
export function normalizeNetworkServerAddress(raw: string): NetworkServerAddress {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "Type the other computer's address, for example 192.168.1.20:8080." };
  }
  const withScheme = SCHEME.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: `"${trimmed}" is not an address. Use the form 192.168.1.20:8080.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Use an http:// or https:// address." };
  }
  if (url.hostname.length === 0) {
    return { ok: false, reason: `"${trimmed}" has no computer name or IP address in it.` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "Leave the password out of the address; put a key in the key field instead." };
  }
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, baseUrl: normalizeOpenAiBaseUrl(`${url.protocol}//${url.host}${path}`) };
}

/** Node / undici words for "nothing answered at that address". */
const UNREACHABLE =
  /\b(?:fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|UND_ERR_CONNECT_TIMEOUT|socket hang up|aborted due to timeout|operation was aborted)\b/i;

/**
 * The reachability verdict for a model list that failed on a server on
 * another computer, in words the operator can act on, or `null` when the
 * URL is not such a server or the error is not "nothing answered" (an
 * HTTP status means the server did answer). The usual causes are all on
 * the other computer: it is asleep, the server is not running, the server
 * listens only on its own 127.0.0.1, or its firewall blocks the port.
 */
export function describeOtherComputerUnreachable(
  baseUrl: string | undefined,
  error: string,
): string | null {
  if (!isOtherComputerOnNetworkUrl(baseUrl)) return null;
  if (/^http \d{3}\b/.test(error) || !UNREACHABLE.test(error)) return null;
  return (
    `nothing answered at ${normalizeOpenAiBaseUrl(baseUrl!)}: check the other computer is on, ` +
    "its model server is running and listening on the network (not only on 127.0.0.1), " +
    "and its firewall lets this port in"
  );
}
