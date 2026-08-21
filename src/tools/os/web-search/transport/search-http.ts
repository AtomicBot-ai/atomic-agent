import {
  runCommand as defaultRunCommand,
  type CommandResult,
} from "../../../../sandbox/command-runner.js";
import {
  assertHostAllowed,
  parseHttpUrl,
  type HostLookup,
} from "../../web-fetch-ssrf-guard.js";
import { CurlUnavailableError, isCurlMissingError } from "../../ensure-curl.js";
import {
  computeRetryDelayMs,
  DEFAULT_SEARCH_RETRY_POLICY,
  parseRetryAfterMs,
  type SearchRetryPolicy,
} from "./retry-after.js";

const CURL_META_MARKER = "__ATOMIC_WEB_SEARCH_META__";
const CURL_HEADER_MARKER = "__ATOMIC_WEB_SEARCH_HEADERS__";
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type SearchHttpMethod = "GET" | "POST";

export interface SearchHttpRequest {
  url: string;
  method?: SearchHttpMethod;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  cwd: string;
  signal: AbortSignal;
  maxResponseBytes?: number;
  runCommand?: typeof defaultRunCommand;
  lookup?: HostLookup;
  /** Overrides the 429 retry schedule; `maxRetries: 0` disables retrying. */
  retryPolicy?: SearchRetryPolicy;
  /** Injectable sleep so tests do not spend real wall-clock in backoff. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injectable clock for deterministic `Retry-After` HTTP-date parsing. */
  now?: () => number;
}

export interface SearchHttpResponse {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
  redirectChain: string[];
}

interface CurlResponse {
  status: number;
  contentType: string;
  redirectUrl: string;
  retryAfter: string;
  body: string;
  truncated: boolean;
}

export async function searchHttp(
  request: SearchHttpRequest,
): Promise<SearchHttpResponse> {
  const policy = request.retryPolicy ?? DEFAULT_SEARCH_RETRY_POLICY;
  const sleep = request.sleep ?? defaultSleep;
  const now = request.now ?? Date.now;

  // Attempt 0 is the initial request; 1..maxRetries are 429 retries. A 429 is
  // retried against the SAME provider before the orchestrator is allowed to
  // advance the chain, so a transient limit cannot permanently downgrade the
  // session to a weaker provider.
  for (let attempt = 0; ; attempt++) {
    const { retryAfter, ...response } = await sendOnce(request);
    if (response.status !== 429 || attempt >= policy.maxRetries) {
      return response;
    }
    const delayMs = computeRetryDelayMs({
      attempt: attempt + 1,
      policy,
      retryAfterMs: parseRetryAfterMs(retryAfter, now()),
    });
    await sleep(delayMs, request.signal);
    // The operator pressed Esc (or the turn was aborted) while we were
    // waiting out a rate limit. Sleeping through the abort and then
    // firing the next request anyway spends the user's quota on a turn
    // that no longer exists — and the request it starts cannot be
    // cancelled by the same signal it just ignored.
    if (request.signal?.aborted) return response;
  }
}

/** Internal shape: the public response plus the header the retry loop reads. */
interface SearchHttpAttempt extends SearchHttpResponse {
  retryAfter: string;
}

/** One full request/redirect walk. Retrying re-enters this from the top. */
async function sendOnce(
  request: SearchHttpRequest,
): Promise<SearchHttpAttempt> {
  const runCommand = request.runCommand ?? defaultRunCommand;
  const method = request.method ?? "GET";
  let currentUrl = parseHttpUrl(request.url);
  const chain: string[] = [];

  for (let hop = 0; ; hop++) {
    const pinnedIp = await assertHostAllowed(currentUrl, {
      lookup: request.lookup,
    });
    const curlArgs = buildCurlArgs({
      url: currentUrl,
      pinnedIp,
      method,
      headers: request.headers ?? {},
      hasBody: request.body !== undefined,
      timeoutMs: request.timeoutMs,
    });
    let result: CommandResult;
    try {
      result = await runCommand("curl", curlArgs, {
        cwd: request.cwd,
        timeoutMs: request.timeoutMs + 2_000,
        signal: request.signal,
        input: request.body,
        maxOutputBytes:
          (request.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES) + 1024,
      });
    } catch (err) {
      if (isCurlMissingError(err)) throw new CurlUnavailableError();
      throw err;
    }
    if (result.exitCode !== 0) {
      throw new Error(formatCurlError(result));
    }
    const response = {
      ...parseCurlMeta(result.stdout),
      truncated: result.truncated,
    };
    chain.push(currentUrl.toString());
    if (REDIRECT_STATUSES.has(response.status) && response.redirectUrl.length > 0) {
      if (hop >= MAX_REDIRECTS) {
        throw new Error(`too many redirects (> ${MAX_REDIRECTS})`);
      }
      currentUrl = parseHttpUrl(response.redirectUrl);
      continue;
    }
    return {
      finalUrl: currentUrl.toString(),
      status: response.status,
      contentType: response.contentType,
      body: response.body,
      truncated: response.truncated,
      redirectChain: chain,
      retryAfter: response.retryAfter,
    };
  }
}

/**
 * Abort-aware sleep. A cancelled turn must not sit out the backoff: the
 * pending timer is cleared and the wait resolves immediately so the caller
 * observes the abort on its next checkpoint.
 */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function buildCurlArgs(input: {
  url: URL;
  pinnedIp: string;
  method: SearchHttpMethod;
  headers: Record<string, string>;
  hasBody: boolean;
  timeoutMs: number;
}): string[] {
  const host = input.url.hostname.replace(/^\[|\]$/g, "");
  const port = input.url.port || (input.url.protocol === "https:" ? "443" : "80");
  const resolveTarget = input.pinnedIp.includes(":")
    ? `[${input.pinnedIp}]`
    : input.pinnedIp;
  const args = [
    "-sS",
    // Send `[`, `]`, `{`, `}` in URLs literally. Without this curl reads them
    // as its own range/set glob syntax and fails with "bad range in URL".
    "--globoff",
    "--max-time",
    String(Math.ceil(input.timeoutMs / 1000)),
    "--max-redirs",
    "0",
    "--resolve",
    `${host}:${port}:${resolveTarget}`,
    "-H",
    `User-Agent: ${USER_AGENT}`,
    "-H",
    "Accept-Language: en-US,en;q=0.9",
  ];
  for (const [key, value] of Object.entries(input.headers)) {
    args.push("-H", `${key}: ${value}`);
  }
  if (input.method === "POST" || input.hasBody) {
    args.push("-X", input.method, "--data-binary", "@-");
  }
  args.push(
    "-w",
    `\n${CURL_META_MARKER}%{http_code}|%{content_type}|%{redirect_url}|` +
      `%{size_download}|${CURL_HEADER_MARKER}%header{retry-after}`,
    "--",
    input.url.toString(),
  );
  return args;
}

export function parseCurlMeta(stdout: string): Omit<CurlResponse, "truncated"> {
  const markerIdx = stdout.lastIndexOf(CURL_META_MARKER);
  if (markerIdx === -1) {
    return {
      status: 0,
      contentType: "",
      redirectUrl: "",
      retryAfter: "",
      body: stdout,
    };
  }
  const body = stdout.slice(0, markerIdx).replace(/\n$/, "");
  const meta = stdout.slice(markerIdx + CURL_META_MARKER.length).trim();
  const [statusStr = "", contentType = "", redirectUrl = ""] = meta.split("|");
  const status = Number.parseInt(statusStr, 10);
  // Read the header block off the whole meta line rather than a fixed field:
  // a `Retry-After` value may itself contain `|`, and the marker is the only
  // reliable delimiter. `%header{}` is curl >= 7.83; older curl emits the
  // literal format string, which must not be read as a value.
  const headerIdx = meta.indexOf(CURL_HEADER_MARKER);
  const retryAfter =
    headerIdx === -1
      ? ""
      : meta.slice(headerIdx + CURL_HEADER_MARKER.length).trim();
  return {
    status: Number.isFinite(status) ? status : 0,
    contentType: contentType.trim(),
    redirectUrl: redirectUrl.trim(),
    retryAfter: retryAfter.startsWith("%header{") ? "" : retryAfter,
    body,
  };
}

function formatCurlError(result: CommandResult): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) return stderr;
  if (result.timedOut) return "curl timed out";
  return `curl exited with code ${result.exitCode}`;
}
