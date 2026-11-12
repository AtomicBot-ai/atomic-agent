import { maskSecrets, redactedMarker } from "../../error-reporting/secret-detector.js";
import { isSecretEnvName } from "../../sandbox/command-env.js";

/**
 * What the page said and fetched, for `browser.debug` (ATO-701): console
 * messages and uncaught page errors, finished requests with their status
 * and failed ones with the reason. The backend feeds it from Playwright's
 * `console`, `weberror`, `response` and `requestfailed` events; nothing
 * here touches the browser.
 *
 * Bounded: each kind keeps its last `RING_ALL` entries, and its last
 * `RING_ERRORS` errors in a ring of their own, so a page that loads a
 * hundred images does not push the one failed API call out. Text is
 * clipped and passed through the secret detector; a URL loses its
 * user info, and the values of query parameters whose name says secret
 * (`token`, `api_key`, `sig`, `code`...) and any fragment that carries
 * parameters. Headers and bodies are never kept.
 */

export const RING_ALL = 200;
export const RING_ERRORS = 100;
const MAX_TEXT_CHARS = 500;
const MAX_URL_CHARS = 300;

export type ConsoleLevel = "log" | "debug" | "info" | "warning" | "error" | "pageerror";

export interface ConsoleEntry {
  /** Milliseconds since the epoch. */
  at: number;
  level: ConsoleLevel;
  text: string;
  /** Script that logged it, `url:line`, when known. */
  source?: string;
  /** Page the message came from. */
  pageUrl: string;
}

export interface NetworkEntry {
  at: number;
  method: string;
  url: string;
  /** `document`, `xhr`, `fetch`, `script`... */
  resourceType: string;
  /** HTTP status of a finished request. */
  status?: number;
  /** Why a request failed without a response (`net::ERR_...`). */
  failure?: string;
  pageUrl: string;
}

export type DebugLogKind = "console" | "network";

/** Query parameter names that carry a credential besides the env-style ones. */
const SECRET_QUERY_NAMES = new Set([
  "code",
  "sig",
  "signature",
  "x-amz-signature",
  "x-goog-signature",
  "x-amz-credential",
  "x-amz-security-token",
  "auth",
  "jwt",
  "otp",
  "sid",
  "session",
  "sessionid",
]);

/** The detector's own marker, which it never matches again. */
const REDACTED = redactedMarker("secret");
/** The same marker as a query value serializes it. */
const REDACTED_IN_QUERY = new URLSearchParams({ v: REDACTED }).toString().slice(2);

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A URL safe to show: no user info, secret query values and parameter fragments masked. */
export function redactDebugUrl(raw: string): string {
  let out = raw;
  try {
    const url = new URL(raw);
    if (url.protocol === "data:" || url.protocol === "blob:") {
      return clip(`${url.protocol}…`, MAX_URL_CHARS);
    }
    url.username = "";
    url.password = "";
    for (const name of [...new Set(url.searchParams.keys())]) {
      if (SECRET_QUERY_NAMES.has(name.toLowerCase()) || isSecretEnvName(name)) {
        url.searchParams.set(name, REDACTED);
      }
    }
    // `#access_token=...` (OAuth implicit flow) and friends.
    if (url.hash.includes("=")) url.hash = REDACTED;
    out = url.toString().split(REDACTED_IN_QUERY).join(REDACTED);
  } catch {
    // Not a URL Node can parse: the detector below still runs.
  }
  return clip(maskSecrets(out), MAX_URL_CHARS);
}

/** Message text safe to show: secrets masked, one bounded line block. */
export function redactDebugText(raw: string): string {
  return clip(maskSecrets(raw), MAX_TEXT_CHARS);
}

class Ring<T> {
  private items: T[] = [];
  constructor(private readonly cap: number) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
  }
  list(): T[] {
    return [...this.items];
  }
  clear(): void {
    this.items = [];
  }
}

export class PageDebugLog {
  private readonly consoleAll = new Ring<ConsoleEntry>(RING_ALL);
  private readonly consoleErrors = new Ring<ConsoleEntry>(RING_ERRORS);
  private readonly networkAll = new Ring<NetworkEntry>(RING_ALL);
  private readonly networkErrors = new Ring<NetworkEntry>(RING_ERRORS);

  constructor(private readonly now: () => number = Date.now) {}

  addConsole(input: { level: string; text: string; source?: string; pageUrl: string }): void {
    const level = normalizeLevel(input.level);
    const entry: ConsoleEntry = {
      at: this.now(),
      level,
      text: redactDebugText(input.text),
      ...(input.source ? { source: redactDebugUrl(input.source) } : {}),
      pageUrl: redactDebugUrl(input.pageUrl),
    };
    this.consoleAll.push(entry);
    if (level === "error" || level === "pageerror") this.consoleErrors.push(entry);
  }

  addResponse(input: { method: string; url: string; resourceType: string; status: number; pageUrl: string }): void {
    this.addNetwork({ ...input, failure: undefined });
  }

  addFailure(input: { method: string; url: string; resourceType: string; failure: string; pageUrl: string }): void {
    this.addNetwork({ ...input, status: undefined });
  }

  private addNetwork(input: {
    method: string;
    url: string;
    resourceType: string;
    status: number | undefined;
    failure: string | undefined;
    pageUrl: string;
  }): void {
    const entry: NetworkEntry = {
      at: this.now(),
      method: input.method.toUpperCase().slice(0, 16),
      url: redactDebugUrl(input.url),
      resourceType: input.resourceType.slice(0, 32),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.failure !== undefined ? { failure: redactDebugText(input.failure) } : {}),
      pageUrl: redactDebugUrl(input.pageUrl),
    };
    this.networkAll.push(entry);
    if (isFailedRequest(entry)) this.networkErrors.push(entry);
  }

  console(errorsOnly: boolean): ConsoleEntry[] {
    return (errorsOnly ? this.consoleErrors : this.consoleAll).list();
  }

  network(errorsOnly: boolean): NetworkEntry[] {
    return (errorsOnly ? this.networkErrors : this.networkAll).list();
  }

  clear(kind: DebugLogKind): void {
    if (kind === "console") {
      this.consoleAll.clear();
      this.consoleErrors.clear();
    } else {
      this.networkAll.clear();
      this.networkErrors.clear();
    }
  }
}

/** A request that got no response, or an HTTP error status. */
export function isFailedRequest(entry: NetworkEntry): boolean {
  return entry.failure !== undefined || (entry.status !== undefined && entry.status >= 400);
}

function normalizeLevel(level: string): ConsoleLevel {
  switch (level) {
    case "error":
    case "pageerror":
    case "debug":
    case "info":
      return level;
    case "warning":
    case "warn":
      return "warning";
    default:
      return "log";
  }
}
