import {
  runCommand as defaultRunCommand,
  type CommandResult,
} from "../../sandbox/command-runner.js";
import { CurlUnavailableError, isCurlMissingError } from "./ensure-curl.js";
import { parseRetryAfterValueMs } from "./retry-after-header.js";
import {
  assertHostAllowed,
  formatResolveEntry,
  parseHttpUrl,
  SsrfBlockedError,
  type HostLookup,
} from "./web-fetch-ssrf-guard.js";

/**
 * Marker appended to curl stdout via `-w` so the response body can be split
 * from structured metadata without `curl -i` (which mixes redirect chains
 * into the body). Deterministic for tests.
 */
export const CURL_META_MARKER = "__ATOMIC_CURL_META__";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Statuses worth a second attempt: transient-by-contract, and the same set
 * `os.web.fetch` retries. Everything else — 404, 403, 400 — is a stable
 * answer that a repeat would only re-spend task budget on.
 */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Statuses at which a server is explicitly asking the client to come back.
 * A non-idempotent request is only retried on these, and only when the
 * server also sent a `Retry-After` (see `isRetryableAttempt`).
 */
const INVITED_RETRY_STATUSES = new Set([429, 503]);

/** curl's "operation timed out" exit. The other exits are not transient. */
const CURL_EXIT_TIMEOUT = 28;

/**
 * Methods that are safe to replay. A GET carries no side effect, so a repeat
 * is free. A POST may already have been processed by the origin even when the
 * response never arrived, so replaying it blindly risks a double submit — the
 * one failure mode a retry layer must not introduce.
 */
const IDEMPOTENT_METHODS = new Set<HttpMethod>(["GET"]);

export interface HttpRetryConfig {
  /** Extra attempts on top of the first. `0` disables retrying. */
  maxRetries: number;
  /** First backoff step; each subsequent retry doubles it. */
  retryBaseDelayMs: number;
  /** Ceiling on any single wait, including a server-sent `Retry-After`. */
  retryMaxDelayMs: number;
}

/** Mirrors `web.fetch`'s retry defaults so the two tools behave alike. */
export const DEFAULT_HTTP_RETRY_CONFIG: HttpRetryConfig = {
  maxRetries: 2,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 5_000,
};

export type HttpMethod = "GET" | "POST";

export interface HttpRequestArgs {
  method: HttpMethod;
  headers: Record<string, string>;
  body: string | undefined;
  timeoutMs: number;
  followRedirects: boolean;
}

export interface GuardedCurlResponse {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  sizeDownload: number;
  timeTotal: number;
  truncated: boolean;
  redirectChain: string[];
  /** Server-sent `Retry-After` in ms, `null` when absent or unparseable. */
  retryAfterMs: number | null;
  /** Last curl argv (for diagnostics). */
  command: string[];
}

export interface ExecuteGuardedHttpOptions {
  runCommand?: typeof defaultRunCommand;
  lookup?: HostLookup;
  cwd: string;
  signal: AbortSignal;
  maxResponseBytes: number;
  /** Retry schedule; omitted means `DEFAULT_HTTP_RETRY_CONFIG`. */
  retry?: HttpRetryConfig;
  /** Injectable sleep so retry-backoff tests do not wait in real time. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Fetch `rawUrl` under the same SSRF rules as `os.web.fetch`:
 * resolve every hop, reject private/internal addresses, pin curl with
 * `--resolve`, never use bare `-L` (which would skip hop re-checks).
 */
export async function executeGuardedHttpRequest(
  rawUrl: string,
  args: HttpRequestArgs,
  opts: ExecuteGuardedHttpOptions,
): Promise<GuardedCurlResponse> {
  const retry = opts.retry ?? DEFAULT_HTTP_RETRY_CONFIG;
  const sleep = opts.sleep ?? defaultSleep;

  // Cumulative across attempts. `sendGuardedRequestOnce` advances `url`,
  // `method` and `body` before each hop it issues, so a retry — whether after
  // a retryable status or a timeout — resumes at the hop that actually failed
  // instead of re-walking redirects the origin has already served.
  const state: RequestWalkState = {
    url: rawUrl,
    method: args.method,
    body: args.body,
    chain: [],
    redirects: 0,
    totalTime: 0,
    truncated: false,
  };

  for (let attempt = 0; ; attempt++) {
    let response: GuardedCurlResponse | null = null;
    let failure: unknown = null;
    try {
      response = await sendGuardedRequestOnce(args, opts, state);
    } catch (err) {
      // Only a curl timeout is worth another attempt; a missing binary, an
      // SSRF rejection, or an aborted run must surface immediately.
      if (
        !isCurlTransportError(err) ||
        err.exitCode !== CURL_EXIT_TIMEOUT
      ) {
        throw err;
      }
      failure = err;
    }

    // The replay-safety question is about the method of the hop that actually
    // ran, not the one the caller passed in: a 307/308 carries a POST forward,
    // and a 303 downgrades it to a bodyless GET that is safe to replay.
    // `state.method` tracks that on both the response and the failure path.
    const exhausted = attempt >= retry.maxRetries || opts.signal.aborted;
    if (exhausted || !isRetryableAttempt(state.method, response, failure)) {
      if (response !== null) return response;
      throw failure;
    }

    await sleep(
      httpBackoffDelayMs(attempt, response?.retryAfterMs ?? null, retry),
      opts.signal,
    );

    // The sleep resolves on abort rather than rejecting, so re-check here.
    // Without this an Esc during the backoff still spawns one more curl.
    if (opts.signal.aborted) {
      if (response !== null) return response;
      throw failure;
    }
  }
}

/**
 * Whether this attempt earns a retry.
 *
 * A GET is replayed on any transient status or a timeout. A non-idempotent
 * method (POST) is replayed only when the server sent an explicit invitation
 * — a `Retry-After` alongside 429/503 — because the origin may already have
 * processed a request whose response never arrived. A bare 502/504 or a
 * timeout on a POST is therefore returned as-is rather than double-submitted.
 *
 * `method` is the method of the hop that actually ran, not the caller's: a
 * 307/308 carries a POST forward, so replaying the chain would re-submit the
 * body even though the request "started" as a redirect follow.
 */
function isRetryableAttempt(
  method: HttpMethod,
  response: GuardedCurlResponse | null,
  failure: unknown,
): boolean {
  const idempotent = IDEMPOTENT_METHODS.has(method);

  if (failure !== null) return idempotent;
  if (response === null) return false;
  if (!RETRYABLE_STATUSES.has(response.status)) return false;
  if (idempotent) return true;

  return (
    INVITED_RETRY_STATUSES.has(response.status) &&
    response.retryAfterMs !== null
  );
}

/**
 * Delay before retry `attempt` (0-based): `retryBaseDelayMs * 2^attempt`,
 * clamped to `retryMaxDelayMs`. A server-sent `Retry-After` wins over the
 * computed delay — the origin knows its own recovery window — but is clamped
 * the same way so a hostile value cannot park the agent.
 */
function httpBackoffDelayMs(
  attempt: number,
  retryAfterMs: number | null,
  cfg: HttpRetryConfig,
): number {
  const backoff = cfg.retryBaseDelayMs * 2 ** attempt;
  const chosen = retryAfterMs !== null ? retryAfterMs : backoff;
  return Math.min(cfg.retryMaxDelayMs, Math.max(0, chosen));
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * State that survives across retry attempts.
 *
 * Everything here is cumulative on purpose. Keeping it inside the per-attempt
 * function meant a resumed retry rebuilt it from the resume point: the
 * redirect chain lost its earlier hops, elapsed time under-reported, the
 * redirect budget reset so a hostile origin got `MAX_REDIRECTS` *per attempt*,
 * and — because it was only written back on the response path — a transport
 * failure left `url`/`method` stale and rewound the retry to the caller's URL.
 */
interface RequestWalkState {
  /** Where the next attempt starts: the last hop actually reached. */
  url: string;
  /** Method of that hop. A 307/308 keeps a POST; a 301/302/303 drops to GET. */
  method: HttpMethod;
  /** Body of that hop — `undefined` once a redirect has dropped it. */
  body: string | undefined;
  /** Every hop visited across all attempts, in order. */
  chain: string[];
  /** Redirects followed across all attempts, against `MAX_REDIRECTS`. */
  redirects: number;
  /** Summed curl time across all attempts. */
  totalTime: number;
  /** Sticky once any attempt truncated the response. */
  truncated: boolean;
}

/** One full request/redirect walk. A retry re-enters this from the top. */
async function sendGuardedRequestOnce(
  args: HttpRequestArgs,
  opts: ExecuteGuardedHttpOptions,
  state: RequestWalkState,
): Promise<GuardedCurlResponse> {
  const runCommand = opts.runCommand ?? defaultRunCommand;
  let currentUrl = parseHttpUrl(state.url);
  let method = state.method;
  let body = state.body;
  const chain = state.chain;
  let lastCommand: string[] = [];

  for (;;) {
    const pinnedIps = await assertHostAllowed(currentUrl, {
      lookup: opts.lookup,
    });
    const curlArgs = buildPinnedCurlArgs({
      url: currentUrl,
      pinnedIps,
      method,
      headers: args.headers,
      body,
      timeoutMs: args.timeoutMs,
    });
    lastCommand = ["curl", ...curlArgs];

    // Record the hop we are about to make *before* issuing it, so a failure
    // resumes here rather than rewinding to the caller's URL and re-walking
    // redirects the origin has already served.
    state.url = currentUrl.toString();
    state.method = method;
    state.body = body;

    let result: CommandResult;
    try {
      result = await runCommand("curl", curlArgs, {
        cwd: opts.cwd,
        timeoutMs: args.timeoutMs + 2_000,
        signal: opts.signal,
        maxOutputBytes: opts.maxResponseBytes + 1024,
        input: body,
      });
    } catch (err) {
      if (isCurlMissingError(err)) throw new CurlUnavailableError();
      throw err;
    }

    if (result.exitCode !== 0) {
      const err = new Error(formatCurlError(result));
      (err as Error & { curlExit: true; command: string[] }).curlExit = true;
      (err as Error & { command: string[] }).command = lastCommand;
      (err as Error & { exitCode: number | null }).exitCode =
        result.exitCode;
      (err as Error & { stderr: string }).stderr = result.stderr.trim();
      throw err;
    }

    const parsed = parseCurlOutput(result.stdout);
    state.truncated = state.truncated || result.truncated;
    state.totalTime += parsed.timeTotal;
    chain.push(currentUrl.toString());

    const shouldFollow =
      args.followRedirects &&
      REDIRECT_STATUSES.has(parsed.status) &&
      parsed.redirectUrl.length > 0;

    if (shouldFollow) {
      // Cumulative across attempts: a per-attempt budget would let a hostile
      // origin serve MAX_REDIRECTS hops on every retry.
      if (state.redirects >= MAX_REDIRECTS) {
        throw new Error(
          `os.http.request: too many redirects (> ${MAX_REDIRECTS})`,
        );
      }
      state.redirects += 1;
      // Curl -L semantics: 301/302/303 drop to GET without body; 307/308 keep method+body.
      if (parsed.status === 301 || parsed.status === 302 || parsed.status === 303) {
        method = "GET";
        body = undefined;
      }
      currentUrl = parseHttpUrl(parsed.redirectUrl);
      continue;
    }

    return {
      finalUrl: currentUrl.toString(),
      status: parsed.status,
      contentType: parsed.contentType,
      body: parsed.body,
      sizeDownload: parsed.sizeDownload,
      timeTotal: state.totalTime,
      truncated: state.truncated,
      redirectChain: [...chain],
      retryAfterMs: parseRetryAfterValueMs(parsed.retryAfter),
      command: lastCommand,
    };
  }
}

export function isCurlTransportError(
  err: unknown,
): err is Error & {
  curlExit: true;
  command: string[];
  exitCode: number | null;
  stderr: string;
} {
  return (
    err instanceof Error &&
    (err as Error & { curlExit?: boolean }).curlExit === true
  );
}

export { SsrfBlockedError };

interface BuildPinnedCurlArgs {
  url: URL;
  pinnedIps: readonly string[];
  method: HttpMethod;
  headers: Record<string, string>;
  body: string | undefined;
  timeoutMs: number;
}

function buildPinnedCurlArgs(input: BuildPinnedCurlArgs): string[] {
  const host = input.url.hostname.replace(/^\[|\]$/g, "");
  const port =
    input.url.port || (input.url.protocol === "https:" ? "443" : "80");
  const argv: string[] = [
    "-sS",
    // Send `[`, `]`, `{`, `}` in URLs literally. Without this curl reads them
    // as its own range/set glob syntax and fails with "bad range in URL".
    "--globoff",
    "--max-time",
    String(Math.ceil(input.timeoutMs / 1000)),
    // Hop-by-hop follow is owned by executeGuardedHttpRequest so each
    // Location can be re-validated. Never bare `-L` here.
    "--max-redirs",
    "0",
    "--resolve",
    formatResolveEntry(host, port, input.pinnedIps),
  ];
  if (input.method !== "GET") argv.push("-X", input.method);
  for (const [key, value] of Object.entries(input.headers)) {
    argv.push("-H", `${key}: ${value}`);
  }
  if (input.body !== undefined) {
    argv.push("--data-binary", "@-");
  }
  argv.push(
    "-w",
    `\n${CURL_META_MARKER}%{http_code}|%{content_type}|%{size_download}|` +
      // `redirect_url` goes last: it is the one field whose value can contain
      // a literal `|` (RFC 3986 disallows it, but origins emit it and curl
      // reports it verbatim). Anything after it would be shifted out of place,
      // so nothing follows it.
      `%{time_total}|%header{retry-after}|%{redirect_url}`,
  );
  argv.push("--", input.url.toString());
  return argv;
}

export interface CurlParsedOutput {
  body: string;
  status: number;
  contentType: string;
  sizeDownload: number;
  timeTotal: number;
  redirectUrl: string;
  /** Raw `Retry-After` header, `""` when absent or unsupported by curl. */
  retryAfter: string;
}

export function parseCurlOutput(stdout: string): CurlParsedOutput {
  const markerIdx = stdout.lastIndexOf(CURL_META_MARKER);
  if (markerIdx === -1) {
    return {
      body: stdout,
      status: 0,
      contentType: "",
      sizeDownload: stdout.length,
      timeTotal: 0,
      redirectUrl: "",
      retryAfter: "",
    };
  }
  const body = stdout.slice(0, markerIdx).replace(/\n$/, "");
  const meta = stdout.slice(markerIdx + CURL_META_MARKER.length).trim();
  // `redirect_url` is last and may itself contain `|`, so split off only the
  // fixed leading fields and keep the remainder intact as the URL.
  const [
    statusStr = "",
    contentType = "",
    sizeStr = "",
    timeStr = "",
    retryAfterRaw = "",
    ...redirectRest
  ] = meta.split("|");
  const redirectUrl = redirectRest.join("|");
  const status = Number.parseInt(statusStr, 10);
  const sizeDownload = Number.parseInt(sizeStr, 10);
  const timeTotal = Number.parseFloat(timeStr);
  // `%header{}` is curl >= 7.83; older curl emits the literal format string,
  // which must not be mistaken for a header value.
  const retryAfter = retryAfterRaw.trim();
  return {
    body,
    status: Number.isFinite(status) ? status : 0,
    contentType: contentType.trim(),
    sizeDownload: Number.isFinite(sizeDownload) ? sizeDownload : body.length,
    timeTotal: Number.isFinite(timeTotal) ? timeTotal : 0,
    redirectUrl: redirectUrl.trim(),
    retryAfter: retryAfter.startsWith("%header{") ? "" : retryAfter,
  };
}

function formatCurlError(result: CommandResult): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) return stderr;
  if (result.timedOut) return "curl timed out";
  return `curl exited with code ${result.exitCode}`;
}
