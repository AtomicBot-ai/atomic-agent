import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  runCommand as defaultRunCommand,
  type CommandResult,
} from "../../sandbox/command-runner.js";
import type { ToolDefinition } from "../tool-registry.js";
import { extractWebContent, type ExtractMode } from "./web-fetch-extract.js";
import {
  assertHostAllowed,
  parseHttpUrl,
  SsrfBlockedError,
  type HostLookup,
} from "./web-fetch-ssrf-guard.js";

const TOOL_NAME = "os.web.fetch";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
const DEFAULT_MAX_CHARS = 50_000;
const MAX_CHARS_CAP = 50_000;

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
}

interface WebFetchArgs {
  url: string;
  mode: ExtractMode;
  maxChars: number;
}

interface CurlResponse {
  status: number;
  contentType: string;
  redirectUrl: string;
  body: string;
  truncated: boolean;
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
  return {
    name: TOOL_NAME,
    description:
      "Read a web page as readable markdown/text. Fetches via curl and " +
      "extracts content: prefers Cloudflare 'Markdown for Agents' " +
      "(Accept: text/markdown), then Mozilla Readability, then a basic " +
      "tag-stripping fallback. GET only, no auth headers, no JavaScript " +
      "(use browser.* for JS-heavy pages). Blocks private/internal " +
      "addresses (SSRF) and re-validates each redirect hop. For raw " +
      "API/JSON responses, custom headers, auth, or POST, use " +
      "os.http.request instead.",
    readonly: true,
    async run(rawArgs, ctx) {
      const args = parseArgs(rawArgs);
      let outcome: FetchOutcome;
      try {
        outcome = await fetchWithGuard(args.url, {
          runCommand,
          lookup: options.lookup,
          cwd: ctx.workingDir,
          signal: ctx.signal,
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

      return compressToolResult(
        {
          tool: TOOL_NAME,
          status: "ok",
          output: text,
          details: {
            url: args.url,
            finalUrl: outcome.finalUrl,
            status: outcome.status,
            contentType: outcome.contentType,
            extractor: extracted.extractor,
            title: extracted.title,
            redirectChain: outcome.redirectChain,
            extractMode: args.mode,
            truncated: outcome.truncated || capped,
          },
        },
        {
          maxSummaryLength: args.maxChars,
          maxTailLines: Number.MAX_SAFE_INTEGER,
        },
      );
    },
  };
}

function parseArgs(rawArgs: Record<string, unknown>): WebFetchArgs {
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
  return { url, mode, maxChars };
}

interface FetchWithGuardOptions {
  runCommand: typeof defaultRunCommand;
  lookup?: HostLookup;
  cwd: string;
  signal: AbortSignal;
}

/**
 * Fetch `rawUrl`, following redirects manually (curl `--max-redirs 0`) so the
 * SSRF guard can re-validate every hop and pin curl to a verified IP via
 * `--resolve`, closing the DNS-rebinding window.
 */
async function fetchWithGuard(
  rawUrl: string,
  opts: FetchWithGuardOptions,
): Promise<FetchOutcome> {
  let currentUrl = parseHttpUrl(rawUrl);
  const chain: string[] = [];
  for (let hop = 0; ; hop++) {
    const pinnedIp = await assertHostAllowed(currentUrl, { lookup: opts.lookup });
    const res = await curlOnce(currentUrl, pinnedIp, opts);
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

async function curlOnce(
  url: URL,
  pinnedIp: string,
  opts: FetchWithGuardOptions,
): Promise<CurlResponse> {
  const curlArgs = buildCurlArgs(url, pinnedIp);
  const result = await opts.runCommand("curl", curlArgs, {
    cwd: opts.cwd,
    timeoutMs: DEFAULT_TIMEOUT_MS + 2_000,
    signal: opts.signal,
    maxOutputBytes: MAX_RESPONSE_BYTES + 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${TOOL_NAME}: ${formatCurlError(result)}`);
  }
  return { ...parseCurlMeta(result.stdout), truncated: result.truncated };
}

function buildCurlArgs(url: URL, pinnedIp: string): string[] {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const resolveTarget = pinnedIp.includes(":") ? `[${pinnedIp}]` : pinnedIp;
  return [
    "-sS",
    "--max-time",
    String(Math.ceil(DEFAULT_TIMEOUT_MS / 1000)),
    "--max-redirs",
    "0",
    "--resolve",
    `${host}:${port}:${resolveTarget}`,
    "-H",
    "Accept: text/markdown, text/html;q=0.9, */*;q=0.1",
    "-H",
    `User-Agent: ${USER_AGENT}`,
    "-H",
    "Accept-Language: en-US,en;q=0.9",
    "-w",
    `\n${CURL_META_MARKER}%{http_code}|%{content_type}|%{redirect_url}|%{size_download}`,
    "--",
    url.toString(),
  ];
}

export function parseCurlMeta(
  stdout: string,
): Omit<CurlResponse, "truncated"> {
  const markerIdx = stdout.lastIndexOf(CURL_META_MARKER);
  if (markerIdx === -1) {
    return { status: 0, contentType: "", redirectUrl: "", body: stdout };
  }
  const body = stdout.slice(0, markerIdx).replace(/\n$/, "");
  const meta = stdout.slice(markerIdx + CURL_META_MARKER.length).trim();
  const [statusStr = "", contentType = "", redirectUrl = ""] = meta.split("|");
  const status = Number.parseInt(statusStr, 10);
  return {
    status: Number.isFinite(status) ? status : 0,
    contentType: contentType.trim(),
    redirectUrl: redirectUrl.trim(),
    body,
  };
}

function formatCurlError(result: CommandResult): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) return stderr;
  if (result.timedOut) return "curl timed out";
  return `curl exited with code ${result.exitCode}`;
}
