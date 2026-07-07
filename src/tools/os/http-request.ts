import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  runCommand as defaultRunCommand,
  type CommandResult,
} from "../../sandbox/command-runner.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";
import type {
  AtomicAgentConfig,
  HttpApprovalMode,
} from "../../config/index.js";
import type { ToolDefinition } from "../tool-registry.js";
import { CurlUnavailableError, isCurlMissingError } from "./ensure-curl.js";

/**
 * Marker we append to curl stdout via `-w` so we can split the response
 * body from the structured metadata without relying on `curl -i` (which
 * mixes redirect chains into the body). The token is random-looking but
 * deterministic so tests can assert on it.
 */
const CURL_META_MARKER = "__ATOMIC_CURL_META__";

export type HttpMethod = "GET" | "POST";

export interface OsHttpRequestOptions extends DangerousToolOptions {
  config: Pick<AtomicAgentConfig, "http">;
  runCommand?: typeof defaultRunCommand;
}

interface HttpArgs {
  url: string;
  urlObj: URL;
  method: HttpMethod;
  headers: Record<string, string>;
  body: string | undefined;
  timeoutMs: number;
  followRedirects: boolean;
}

export function buildOsHttpRequestTool(
  options: OsHttpRequestOptions,
): ToolDefinition {
  const runCommand = options.runCommand ?? defaultRunCommand;
  return {
    name: "os.http.request",
    description:
      "Raw HTTP GET or POST via the system `curl` binary for APIs and machine-readable endpoints (JSON, XML, plain text). Returns the response body verbatim — no HTML extraction or cleanup. To read a human web page as markdown/text, use `os.web.fetch` instead. Host allowlist and approval policy come from `config.http`. Body is capped at `config.http.maxResponseBytes`.",
    readonly: false,
    async run(rawArgs, ctx) {
      const httpCfg = options.config.http;
      if (!httpCfg.enabled) {
        throw new Error(
          "os.http.request: disabled by config (`http.enabled = false`).",
        );
      }
      const args = parseArgs(rawArgs, httpCfg.defaultTimeoutMs);
      if (!hostAllowed(args.urlObj.hostname, httpCfg.hostAllowlist)) {
        throw new Error(
          `os.http.request: host ${args.urlObj.hostname} is not in config.http.hostAllowlist`,
        );
      }
      if (needsApproval(httpCfg.approvalMode, args.method)) {
        await requireApproval(
          options,
          {
            sessionId: ctx.sessionId,
            tool: "os.http.request",
            reason: `${args.method} ${args.url}`,
            preview: buildApprovalPreview(args),
            affectedResources: [args.url],
          },
          ctx.signal,
        );
      }

      const curlArgs = buildCurlArgs(args);
      let commandResult: CommandResult;
      try {
        commandResult = await runCommand("curl", curlArgs, {
          cwd: ctx.workingDir,
          timeoutMs: args.timeoutMs + 2_000,
          signal: ctx.signal,
          maxOutputBytes: httpCfg.maxResponseBytes + 1024,
          input: args.body,
        });
      } catch (err) {
        if (isCurlMissingError(err)) {
          return compressToolResult({
            tool: "os.http.request",
            status: "error",
            output: new CurlUnavailableError().message,
            details: { url: args.url, method: args.method },
          });
        }
        throw err;
      }

      if (commandResult.exitCode !== 0) {
        return compressToolResult({
          tool: "os.http.request",
          status: "error",
          output: formatCurlError(commandResult),
          details: {
            exitCode: commandResult.exitCode,
            stderr: commandResult.stderr.trim(),
            url: args.url,
            method: args.method,
            command: ["curl", ...curlArgs],
          },
        });
      }

      const parsed = parseCurlOutput(commandResult.stdout);
      const truncated = commandResult.truncated;
      // An HTTP status >= 400 is a real failure signal. Returning
      // `status:"ok"` here masked erroring endpoints from the model and
      // from the loop detector's semantic result hash, letting the agent
      // hammer the same dead endpoint indefinitely. Surface it as an
      // error while keeping the response body in `details.body` so the
      // model can still inspect any error payload.
      const isHttpError = parsed.status >= 400;
      // Return the body verbatim — this tool is the raw-HTTP surface. HTML
      // extraction (markdown/text) is the job of `os.web.fetch`. Lift the
      // compressor caps so small JSON payloads that would otherwise be
      // cropped to 400 chars / 12 lines survive intact for the LLM. The
      // body is already bounded by curl via `maxResponseBytes`; the
      // downstream rendering layer applies its own per-turn cap.
      return compressToolResult(
        {
          tool: "os.http.request",
          status: isHttpError ? "error" : "ok",
          output: isHttpError
            ? `HTTP ${parsed.status} ${args.method} ${args.url}`
            : parsed.body,
          details: {
            url: args.url,
            method: args.method,
            status: parsed.status,
            contentType: parsed.contentType,
            sizeDownload: parsed.sizeDownload,
            timeTotalSeconds: parsed.timeTotal,
            truncated,
            command: ["curl", ...curlArgs],
            ...(isHttpError ? { body: parsed.body } : {}),
          },
        },
        {
          maxSummaryLength: httpCfg.maxResponseBytes,
          maxTailLines: Number.MAX_SAFE_INTEGER,
        },
      );
    },
  };
}

function parseArgs(
  rawArgs: Record<string, unknown>,
  defaultTimeoutMs: number,
): HttpArgs {
  const url = rawArgs.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("os.http.request: `url` must be a non-empty string");
  }
  let urlObj: URL;
  try {
    urlObj = new URL(url);
  } catch {
    throw new Error(`os.http.request: invalid URL ${JSON.stringify(url)}`);
  }
  if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
    throw new Error(
      `os.http.request: only http/https URLs are supported (got ${urlObj.protocol})`,
    );
  }

  const rawMethod =
    typeof rawArgs.method === "string"
      ? rawArgs.method.toUpperCase()
      : "GET";
  if (rawMethod !== "GET" && rawMethod !== "POST") {
    throw new Error(
      `os.http.request: only GET and POST are supported (got ${JSON.stringify(rawArgs.method)})`,
    );
  }
  const method = rawMethod as HttpMethod;

  const headers: Record<string, string> = {};
  const rawHeaders = rawArgs.headers;
  if (rawHeaders !== undefined && rawHeaders !== null) {
    if (typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) {
      throw new Error(
        "os.http.request: `headers` must be an object of string key/value pairs",
      );
    }
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof key !== "string" || key.length === 0) continue;
      if (typeof value !== "string") {
        throw new Error(
          `os.http.request: header ${JSON.stringify(key)} must be a string`,
        );
      }
      if (key.includes("\n") || key.includes("\r") || value.includes("\n") || value.includes("\r")) {
        // Block CRLF-injection into curl header args.
        throw new Error(
          `os.http.request: header ${JSON.stringify(key)} contains CR/LF which is not allowed`,
        );
      }
      headers[key] = value;
    }
  }

  // Default a permissive Accept that satisfies both plain JSON APIs and
  // MCP-over-HTTP endpoints that reply with Server-Sent Events (e.g. the
  // Exa search endpoint, which returns HTTP 406 when `text/event-stream`
  // is absent from Accept). An explicit `Accept` from the model always
  // wins; this only fills the gap when none was provided.
  if (!hasHeader(headers, "accept")) {
    headers["Accept"] = "application/json, text/event-stream";
  }

  let body: string | undefined;
  const rawBody = rawArgs.body;
  if (rawBody !== undefined && rawBody !== null) {
    if (typeof rawBody === "string") {
      body = rawBody;
    } else if (typeof rawBody === "object") {
      body = JSON.stringify(rawBody);
      if (!hasHeader(headers, "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    } else {
      throw new Error(
        "os.http.request: `body` must be a string or a JSON-serialisable object",
      );
    }
  }
  if (body !== undefined && method === "GET") {
    throw new Error("os.http.request: `body` is not allowed for GET requests");
  }

  const timeoutMs =
    typeof rawArgs.timeoutMs === "number" && Number.isFinite(rawArgs.timeoutMs)
      ? Math.max(1, Math.trunc(rawArgs.timeoutMs))
      : defaultTimeoutMs;
  const followRedirects = rawArgs.followRedirects !== false;

  return {
    url,
    urlObj,
    method,
    headers,
    body,
    timeoutMs,
    followRedirects,
  };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return true;
  }
  return false;
}

/**
 * Decide whether to route this request through the approval gate. `never`
 * means the LLM can call freely; `always` means every call asks; `writes`
 * means anything that is not a pure read (GET/HEAD) asks. We only support
 * GET + POST today, so in practice `writes` == "POST asks".
 */
function needsApproval(mode: HttpApprovalMode, method: HttpMethod): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return method !== "GET";
}

/**
 * Match `hostname` against an allowlist entry. `null` means "no restriction".
 * Each allowlist entry is either an exact hostname (case-insensitive) or a
 * `*.domain.tld` wildcard (matches any single or multi-level subdomain).
 */
export function hostAllowed(
  hostname: string,
  allowlist: string[] | null,
): boolean {
  if (allowlist === null) return true;
  const lower = hostname.toLowerCase();
  for (const entry of allowlist) {
    const rule = entry.toLowerCase();
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(1); // ".domain.tld"
      if (lower === suffix.slice(1) || lower.endsWith(suffix)) return true;
    } else if (rule === lower) {
      return true;
    }
  }
  return false;
}

function buildApprovalPreview(args: HttpArgs): string {
  const lines: string[] = [`${args.method} ${args.url}`];
  for (const [k, v] of Object.entries(args.headers)) {
    lines.push(`${k}: ${v}`);
  }
  if (args.body !== undefined) {
    const snippet = args.body.length > 400
      ? `${args.body.slice(0, 400)}… [${args.body.length} bytes]`
      : args.body;
    lines.push("");
    lines.push(snippet);
  }
  return lines.join("\n");
}

function buildCurlArgs(args: HttpArgs): string[] {
  const argv: string[] = ["-sS", "--max-time", String(Math.ceil(args.timeoutMs / 1000))];
  if (args.followRedirects) argv.push("-L");
  if (args.method !== "GET") argv.push("-X", args.method);
  for (const [key, value] of Object.entries(args.headers)) {
    argv.push("-H", `${key}: ${value}`);
  }
  if (args.body !== undefined) {
    // Use --data-binary to avoid curl munging newlines.
    argv.push("--data-binary", "@-");
  }
  argv.push(
    "-w",
    `\n${CURL_META_MARKER}%{http_code}|%{content_type}|%{size_download}|%{time_total}`,
  );
  argv.push("--", args.url);
  return argv;
}

interface CurlParsedOutput {
  body: string;
  status: number;
  contentType: string;
  sizeDownload: number;
  timeTotal: number;
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
    };
  }
  const body = stdout.slice(0, markerIdx).replace(/\n$/, "");
  const meta = stdout.slice(markerIdx + CURL_META_MARKER.length).trim();
  const [statusStr = "", contentType = "", sizeStr = "", timeStr = ""] =
    meta.split("|");
  const status = Number.parseInt(statusStr, 10);
  const sizeDownload = Number.parseInt(sizeStr, 10);
  const timeTotal = Number.parseFloat(timeStr);
  return {
    body,
    status: Number.isFinite(status) ? status : 0,
    contentType: contentType.trim(),
    sizeDownload: Number.isFinite(sizeDownload) ? sizeDownload : body.length,
    timeTotal: Number.isFinite(timeTotal) ? timeTotal : 0,
  };
}

function formatCurlError(result: CommandResult): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) return stderr;
  if (result.timedOut) return "curl timed out";
  return `curl exited with code ${result.exitCode}`;
}
