import {
  runCommand as defaultRunCommand,
  type CommandResult,
} from "../../sandbox/command-runner.js";
import { CurlUnavailableError, isCurlMissingError } from "./ensure-curl.js";
import {
  assertHostAllowed,
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
  /** Last curl argv (for diagnostics). */
  command: string[];
}

export interface ExecuteGuardedHttpOptions {
  runCommand?: typeof defaultRunCommand;
  lookup?: HostLookup;
  cwd: string;
  signal: AbortSignal;
  maxResponseBytes: number;
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
  const runCommand = opts.runCommand ?? defaultRunCommand;
  let currentUrl = parseHttpUrl(rawUrl);
  let method = args.method;
  let body = args.body;
  const chain: string[] = [];
  let lastCommand: string[] = [];
  let truncated = false;
  let totalTime = 0;

  for (let hop = 0; ; hop += 1) {
    const pinnedIp = await assertHostAllowed(currentUrl, {
      lookup: opts.lookup,
    });
    const curlArgs = buildPinnedCurlArgs({
      url: currentUrl,
      pinnedIp,
      method,
      headers: args.headers,
      body,
      timeoutMs: args.timeoutMs,
    });
    lastCommand = ["curl", ...curlArgs];

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
    truncated = truncated || result.truncated;
    totalTime += parsed.timeTotal;
    chain.push(currentUrl.toString());

    const shouldFollow =
      args.followRedirects &&
      REDIRECT_STATUSES.has(parsed.status) &&
      parsed.redirectUrl.length > 0;

    if (shouldFollow) {
      if (hop >= MAX_REDIRECTS) {
        throw new Error(
          `os.http.request: too many redirects (> ${MAX_REDIRECTS})`,
        );
      }
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
      timeTotal: totalTime,
      truncated,
      redirectChain: chain,
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
  pinnedIp: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body: string | undefined;
  timeoutMs: number;
}

function buildPinnedCurlArgs(input: BuildPinnedCurlArgs): string[] {
  const host = input.url.hostname.replace(/^\[|\]$/g, "");
  const port =
    input.url.port || (input.url.protocol === "https:" ? "443" : "80");
  const resolveTarget = input.pinnedIp.includes(":")
    ? `[${input.pinnedIp}]`
    : input.pinnedIp;
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
    `${host}:${port}:${resolveTarget}`,
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
    `\n${CURL_META_MARKER}%{http_code}|%{content_type}|%{size_download}|%{time_total}|%{redirect_url}`,
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
    };
  }
  const body = stdout.slice(0, markerIdx).replace(/\n$/, "");
  const meta = stdout.slice(markerIdx + CURL_META_MARKER.length).trim();
  const [
    statusStr = "",
    contentType = "",
    sizeStr = "",
    timeStr = "",
    redirectUrl = "",
  ] = meta.split("|");
  const status = Number.parseInt(statusStr, 10);
  const sizeDownload = Number.parseInt(sizeStr, 10);
  const timeTotal = Number.parseFloat(timeStr);
  return {
    body,
    status: Number.isFinite(status) ? status : 0,
    contentType: contentType.trim(),
    sizeDownload: Number.isFinite(sizeDownload) ? sizeDownload : body.length,
    timeTotal: Number.isFinite(timeTotal) ? timeTotal : 0,
    redirectUrl: redirectUrl.trim(),
  };
}

function formatCurlError(result: CommandResult): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) return stderr;
  if (result.timedOut) return "curl timed out";
  return `curl exited with code ${result.exitCode}`;
}
