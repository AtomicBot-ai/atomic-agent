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

const CURL_META_MARKER = "__ATOMIC_WEB_SEARCH_META__";
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
  body: string;
  truncated: boolean;
}

export async function searchHttp(
  request: SearchHttpRequest,
): Promise<SearchHttpResponse> {
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
    };
  }
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
    `\n${CURL_META_MARKER}%{http_code}|%{content_type}|%{redirect_url}|%{size_download}`,
    "--",
    input.url.toString(),
  );
  return args;
}

export function parseCurlMeta(stdout: string): Omit<CurlResponse, "truncated"> {
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
