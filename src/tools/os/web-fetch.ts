import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  runCommand as defaultRunCommand,
  type CommandResult,
} from "../../sandbox/command-runner.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { AtomicAgentConfig, WebFetchConfig } from "../../config/index.js";
import { extractWebContent, type ExtractMode } from "./web-fetch-extract.js";
import { CurlUnavailableError, isCurlMissingError } from "./ensure-curl.js";
import {
  assertHostAllowed,
  formatResolveEntry,
  parseHttpUrl,
  SsrfBlockedError,
  type HostLookup,
} from "./web-fetch-ssrf-guard.js";

const TOOL_NAME = "os.web.fetch";

const DEFAULT_TIMEOUT_MS = 30_000;
import {
  describeChallenge,
  detectChallenge,
} from "./web-fetch-challenge.js";

const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
const DEFAULT_MAX_CHARS = 50_000;
const MAX_CHARS_CAP = 50_000;

/**
 * Fallback `web.fetch` settings for callers that construct the tool without a
 * config (tests, embedders). Mirrors `USER_CONFIG_DEFAULTS.web.fetch`.
 */
const DEFAULT_FETCH_CONFIG: WebFetchConfig = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  connectTimeoutMs: 10_000,
  maxRetries: 2,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 5_000,
};

/**
 * HTTP statuses worth a second attempt. 503 dominates the field data (and is
 * overwhelmingly `web.archive.org` shedding load, which serves the very same
 * URL seconds later); 429/502/504 are the other transient-by-contract codes.
 * Everything else — notably 4xx like 404/403 — is a stable answer that would
 * only burn budget on a repeat.
 */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/** curl's "operation timed out" exit. The other exits are not transient. */
const CURL_EXIT_TIMEOUT = 28;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Marker appended to curl stdout via `-w` so the response body can be split
 * from the structured metadata without `curl -i` (which mixes headers into
 * the body). Random-looking but deterministic so tests can assert on it.
 */
const CURL_META_MARKER = "__ATOMIC_WEBFETCH_META__";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface OsWebFetchOptions {
  runCommand?: typeof defaultRunCommand;
  lookup?: HostLookup;
  /**
   * Timeout / retry tunables. Optional so existing callers and tests keep
   * working — when absent `DEFAULT_FETCH_CONFIG` applies, which reproduces the
   * pre-v38 30s budget.
   */
  config?: Pick<AtomicAgentConfig, "web">;
  /** Injectable sleep so retry-backoff tests do not wait in real time. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface WebFetchArgs {
  url: string;
  mode: ExtractMode;
  maxChars: number;
  timeoutMs: number;
}

interface CurlResponse {
  status: number;
  contentType: string;
  redirectUrl: string;
  body: string;
  truncated: boolean;
  /** Seconds parsed from a `Retry-After` response header, when present. */
  retryAfterMs: number | null;
}

interface FetchOutcome {
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
  redirectChain: string[];
}

export function buildOsWebFetchTool(
  options: OsWebFetchOptions = {},
): ToolDefinition {
  const runCommand = options.runCommand ?? defaultRunCommand;
  const fetchCfg = options.config?.web.fetch ?? DEFAULT_FETCH_CONFIG;
  const sleep = options.sleep ?? defaultSleep;
  return {
    name: TOOL_NAME,
    description:
      "Read a web page as readable markdown/text. Fetches via curl and " +
      "extracts content: prefers Cloudflare 'Markdown for Agents' " +
      "(Accept: text/markdown), then Mozilla Readability, then a basic " +
      "tag-stripping fallback. GET only, no auth headers, no JavaScript " +
      "(use browser.* for JS-heavy pages; a page that answers with a " +
      "bot-protection challenge is reported as such, with browser.navigate " +
      "named as the way through). Blocks private/internal " +
      "addresses (SSRF) and re-validates each redirect hop. Retries " +
      "transient failures (429/502/503/504, connection timeouts) with " +
      "exponential backoff. Optional `timeoutMs` overrides the configured " +
      "per-attempt budget. For raw API/JSON responses, custom headers, " +
      "auth, or POST, use os.http.request instead.",
    readonly: true,
    async run(rawArgs, ctx) {
      const args = parseArgs(rawArgs, fetchCfg.timeoutMs);
      let outcome: FetchOutcome;
      try {
        outcome = await fetchWithGuard(args.url, {
          runCommand,
          lookup: options.lookup,
          cwd: ctx.workingDir,
          signal: ctx.signal,
          fetchCfg,
          timeoutMs: args.timeoutMs,
          sleep,
        });
      } catch (err) {
        return compressToolResult({
          tool: TOOL_NAME,
          status: "error",
          output: (err as Error).message,
          details: {
            url: args.url,
            blocked: err instanceof SsrfBlockedError,
          },
        });
      }

      // Before extraction: a challenge page extracts perfectly well, and
      // that is the problem — "Just a moment…" comes back looking like
      // the article's first paragraph.
      const challenge = detectChallenge({
        status: outcome.status,
        contentType: outcome.contentType,
        body: outcome.body,
      });
      if (challenge.challenged) {
        return compressToolResult({
          tool: TOOL_NAME,
          status: "error",
          output: describeChallenge(
            outcome.finalUrl,
            outcome.status,
            challenge.marker ?? "",
          ),
          details: {
            url: args.url,
            finalUrl: outcome.finalUrl,
            status: outcome.status,
            challenge: challenge.marker,
            retryWith: "browser.navigate",
          },
        });
      }

      const extracted = extractWebContent({
        body: outcome.body,
        contentType: outcome.contentType,
        url: outcome.finalUrl,
        mode: args.mode,
      });
      const capped = extracted.text.length > args.maxChars;
      const text = capped
        ? `${extracted.text.slice(0, args.maxChars)}\n… [truncated]`
        : extracted.text;

      // HTTP-error status (>= 400) is a real failure signal. Returning
      // `status:"ok"` here masked dead/erroring URLs from the model and
      // from the loop detector's semantic result hash, letting the agent
      // re-fetch the same 404 indefinitely. Surface it as an error while
      // keeping the extracted body in `details.extractedText` so the
      // model can still inspect any error page content.
      const isHttpError = outcome.status >= 400;
      const details = {
        url: args.url,
        finalUrl: outcome.finalUrl,
        status: outcome.status,
        contentType: outcome.contentType,
        extractor: extracted.extractor,
        title: extracted.title,
        redirectChain: outcome.redirectChain,
        extractMode: args.mode,
        truncated: outcome.truncated || capped,
        ...(isHttpError ? { extractedText: text } : {}),
      };

      return compressToolResult(
        {
          tool: TOOL_NAME,
          status: isHttpError ? "error" : "ok",
          output: isHttpError
            ? `HTTP ${outcome.status} for ${outcome.finalUrl}`
            : text,
          details,
        },
        {
          maxSummaryLength: args.maxChars,
          maxTailLines: Number.MAX_SAFE_INTEGER,
        },
      );
    },
  };
}

function parseArgs(
  rawArgs: Record<string, unknown>,
  defaultTimeoutMs: number,
): WebFetchArgs {
  const url = rawArgs.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(`${TOOL_NAME}: \`url\` must be a non-empty string`);
  }
  const rawMode = rawArgs.extractMode;
  let mode: ExtractMode = "markdown";
  if (rawMode !== undefined) {
    if (rawMode !== "markdown" && rawMode !== "text") {
      throw new Error(
        `${TOOL_NAME}: \`extractMode\` must be "markdown" or "text"`,
      );
    }
    mode = rawMode;
  }
  let maxChars = DEFAULT_MAX_CHARS;
  if (typeof rawArgs.maxChars === "number" && Number.isFinite(rawArgs.maxChars)) {
    maxChars = Math.min(MAX_CHARS_CAP, Math.max(1, Math.trunc(rawArgs.maxChars)));
  }
  // Mirrors os.http.request: a per-call `timeoutMs` overrides the configured
  // default so the model can shorten the budget for a host it expects to be
  // slow, instead of losing the full default on every attempt.
  const timeoutMs =
    typeof rawArgs.timeoutMs === "number" && Number.isFinite(rawArgs.timeoutMs)
      ? Math.max(1, Math.trunc(rawArgs.timeoutMs))
      : defaultTimeoutMs;
  return { url, mode, maxChars, timeoutMs };
}

interface FetchWithGuardOptions {
  runCommand: typeof defaultRunCommand;
  lookup?: HostLookup;
  cwd: string;
  signal: AbortSignal;
  fetchCfg: WebFetchConfig;
  /** Effective per-attempt budget (per-call arg, else `fetchCfg.timeoutMs`). */
  timeoutMs: number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Thrown by `curlOnce` when curl itself failed (non-zero exit). */
class CurlFailedError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "CurlFailedError";
  }
}

/**
 * Fetch `rawUrl`, following redirects manually (curl `--max-redirs 0`) so the
 * SSRF guard can re-validate every hop and pin curl to a verified IP via
 * `--resolve`, closing the DNS-rebinding window.
 *
 * Each hop is retried independently for transient failures. `os.web.fetch` is
 * GET-only (no method argument exists, and curl is invoked without `-X`/`-d`),
 * so every request is idempotent and safe to repeat — there is no
 * non-idempotent case to exclude here.
 */
async function fetchWithGuard(
  rawUrl: string,
  opts: FetchWithGuardOptions,
): Promise<FetchOutcome> {
  let currentUrl = parseHttpUrl(rawUrl);
  const chain: string[] = [];
  for (let hop = 0; ; hop++) {
    const res = await fetchHopWithRetry(currentUrl, opts);
    chain.push(currentUrl.toString());
    if (REDIRECT_STATUSES.has(res.status) && res.redirectUrl.length > 0) {
      if (hop >= MAX_REDIRECTS) {
        throw new Error(
          `${TOOL_NAME}: too many redirects (> ${MAX_REDIRECTS})`,
        );
      }
      currentUrl = parseHttpUrl(res.redirectUrl);
      continue;
    }
    return {
      finalUrl: currentUrl.toString(),
      status: res.status,
      contentType: res.contentType,
      body: res.body,
      truncated: res.truncated,
      redirectChain: chain,
    };
  }
}

/**
 * One redirect hop, retried on transient failure with exponential backoff.
 *
 * Retryable: HTTP 429/502/503/504, and curl exit 28 (`--max-time` /
 * `--connect-timeout` expiry). Everything else — a 404, a DNS failure, a TLS
 * error — is returned or thrown on the first attempt, because repeating it only
 * spends task budget for the same answer.
 *
 * The budget is deliberately small (`maxRetries`, default 2). Worst case adds
 * two attempts plus backoff on top of the first, which is bounded by
 * `retryMaxDelayMs` per wait rather than growing without limit. `ctx.signal` is
 * honoured both during the sleep and by `runCommand`, so an aborted task stops
 * immediately instead of finishing its retry ladder.
 */
async function fetchHopWithRetry(
  url: URL,
  opts: FetchWithGuardOptions,
): Promise<CurlResponse> {
  const { maxRetries } = opts.fetchCfg;
  for (let attempt = 0; ; attempt++) {
    // Re-resolve on every attempt: the guard must pin a freshly verified IP
    // rather than trusting one resolved before an arbitrary backoff wait.
    const pinnedIps = await assertHostAllowed(url, { lookup: opts.lookup });

    let res: CurlResponse | null = null;
    let failure: unknown = null;
    try {
      res = await curlOnce(url, pinnedIps, opts);
    } catch (err) {
      // Only a curl timeout is worth another attempt; a missing curl binary or
      // an aborted run must surface immediately.
      if (
        !(err instanceof CurlFailedError) ||
        err.exitCode !== CURL_EXIT_TIMEOUT
      ) {
        throw err;
      }
      failure = err;
    }

    const retryable =
      failure !== null || (res !== null && RETRYABLE_STATUSES.has(res.status));
    if (!retryable || attempt >= maxRetries || opts.signal.aborted) {
      if (res !== null) return res;
      throw failure;
    }

    await opts.sleep(
      backoffDelayMs(attempt, res?.retryAfterMs ?? null, opts.fetchCfg),
      opts.signal,
    );
  }
}

/**
 * Delay before retry `attempt` (0-based): `retryBaseDelayMs * 2^attempt`,
 * clamped to `retryMaxDelayMs`. Defaults give 500ms then 1000ms — long enough
 * for a load-shedding origin like `web.archive.org` to recover, short enough
 * that two retries cost ~1.5s against a 25-minute task budget.
 *
 * A `Retry-After` sent by the server wins over the computed delay, since the
 * origin knows its own recovery window, but is still clamped to
 * `retryMaxDelayMs` so a large or hostile value cannot park the agent.
 */
function backoffDelayMs(
  attempt: number,
  retryAfterMs: number | null,
  cfg: WebFetchConfig,
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

async function curlOnce(
  url: URL,
  pinnedIps: readonly string[],
  opts: FetchWithGuardOptions,
): Promise<CurlResponse> {
  const curlArgs = buildCurlArgs(url, pinnedIps, opts);
  let result: CommandResult;
  try {
    result = await opts.runCommand("curl", curlArgs, {
      cwd: opts.cwd,
      // Outer guard sits just above curl's own `--max-time` so curl reports the
      // timeout itself (exit 28) instead of being killed by the runner.
      timeoutMs: opts.timeoutMs + 2_000,
      signal: opts.signal,
      maxOutputBytes: MAX_RESPONSE_BYTES + 1024,
    });
  } catch (err) {
    if (isCurlMissingError(err)) throw new CurlUnavailableError();
    throw err;
  }
  if (result.exitCode !== 0) {
    throw new CurlFailedError(
      `${TOOL_NAME}: ${formatCurlError(result)}`,
      result.exitCode ?? -1,
    );
  }
  return { ...parseCurlMeta(result.stdout), truncated: result.truncated };
}

function buildCurlArgs(
  url: URL,
  pinnedIps: readonly string[],
  opts: Pick<FetchWithGuardOptions, "fetchCfg" | "timeoutMs">,
): string[] {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  // Never let the connect budget exceed the overall one — a per-call
  // `timeoutMs` smaller than the configured connect timeout must still cap the
  // handshake.
  const connectTimeoutMs = Math.min(
    opts.fetchCfg.connectTimeoutMs,
    opts.timeoutMs,
  );
  return [
    "-sS",
    // Send `[`, `]`, `{`, `}` in URLs literally. Without this curl reads them
    // as its own range/set glob syntax and fails with "bad range in URL".
    "--globoff",
    "--max-time",
    String(Math.ceil(opts.timeoutMs / 1000)),
    // Fail fast on hosts that never complete a handshake instead of holding
    // the whole `--max-time` budget open for them.
    "--connect-timeout",
    String(Math.ceil(connectTimeoutMs / 1000)),
    "--max-redirs",
    "0",
    "--resolve",
    formatResolveEntry(host, port, pinnedIps),
    // Advertise the encodings curl can actually undo, and undo them.
    // Without this, a server that compresses regardless of the request
    // hands back bytes the extractor reads as binary noise — and some
    // hosts behave differently for a client that claims no encoding
    // support at all, since no browser has looked like that in years.
    "--compressed",
    "-H",
    "Accept: text/markdown, text/html;q=0.9, */*;q=0.1",
    "-H",
    `User-Agent: ${USER_AGENT}`,
    "-H",
    "Accept-Language: en-US,en;q=0.9",
    "-w",
    // `%{header_json}` is last on purpose: it is multi-line JSON that can
    // itself contain `|`, so every pipe-delimited field must precede it.
    // Requires curl >= 7.83; older curl emits the literal token, which
    // `parseCurlMeta` tolerates by yielding no Retry-After.
    `\n${CURL_META_MARKER}%{http_code}|%{content_type}|%{redirect_url}|%{size_download}|%{header_json}`,
    "--",
    url.toString(),
  ];
}

export function parseCurlMeta(
  stdout: string,
): Omit<CurlResponse, "truncated"> {
  const markerIdx = stdout.lastIndexOf(CURL_META_MARKER);
  if (markerIdx === -1) {
    return {
      status: 0,
      contentType: "",
      redirectUrl: "",
      body: stdout,
      retryAfterMs: null,
    };
  }
  const body = stdout.slice(0, markerIdx).replace(/\n$/, "");
  const meta = stdout.slice(markerIdx + CURL_META_MARKER.length).trim();
  // Split off exactly the four fixed fields; whatever follows is
  // `%{header_json}`, which may itself contain `|` and newlines.
  const parts = meta.split("|");
  const [statusStr = "", contentType = "", redirectUrl = ""] = parts;
  const headerJson = parts.slice(4).join("|");
  const status = Number.parseInt(statusStr, 10);
  return {
    status: Number.isFinite(status) ? status : 0,
    contentType: contentType.trim(),
    redirectUrl: redirectUrl.trim(),
    body,
    retryAfterMs: parseRetryAfterMs(headerJson),
  };
}

/**
 * Pull `Retry-After` out of curl's `%{header_json}` blob and normalise it to
 * milliseconds. Handles both RFC 9110 forms — delta-seconds and an HTTP-date —
 * and returns `null` for anything unparseable (including older curl builds that
 * do not support `%{header_json}` and emit the literal token instead), so a
 * missing or malformed header simply falls back to plain exponential backoff.
 */
function parseRetryAfterMs(headerJson: string): number | null {
  const trimmed = headerJson.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  // curl lowercases header names, but match case-insensitively regardless.
  const entry = Object.entries(parsed as Record<string, unknown>).find(
    ([key]) => key.toLowerCase() === "retry-after",
  );
  const rawValue = entry?.[1];
  const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0) return null;

  if (/^\d+$/.test(text)) {
    return Number.parseInt(text, 10) * 1000;
  }
  const dateMs = Date.parse(text);
  if (!Number.isNaN(dateMs)) {
    // Past dates clamp to 0 — retry immediately rather than not at all.
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

function formatCurlError(result: CommandResult): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) return stderr;
  if (result.timedOut) return "curl timed out";
  return `curl exited with code ${result.exitCode}`;
}
