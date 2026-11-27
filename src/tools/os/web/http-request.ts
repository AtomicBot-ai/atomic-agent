import { compressToolResult } from "../../../compressor/result-compressor.js";
import {
  runCommand as defaultRunCommand,
  type CommandOptions,
  type CommandResult,
} from "../../../sandbox/command-runner.js";
import {
  requireApproval,
  requireGuardOnShortcut,
  type DangerousToolOptions,
} from "../../../approval/dangerous-tool.js";
import type {
  AtomicAgentConfig,
  HttpApprovalMode,
} from "../../../config/index.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { CurlUnavailableError } from "./ensure-curl.js";
import { httpSecretFinding, readArgScanThreshold } from "./http-body-secrets.js";
import {
  executeGuardedHttpRequest,
  isCurlTransportError,
  type HttpMethod,
  SsrfBlockedError,
} from "./http-request-fetch.js";
import {
  buildHttpApprovalPreview,
  maskUrlSecrets,
} from "./http-request-preview.js";
import type { HostLookup } from "./web-fetch-ssrf-guard.js";
import {
  checkUrlSend,
  DEFAULT_URL_DATA_GUARD,
  noteUrlSendAllowed,
  urlSendReason,
  type UrlSendSites,
} from "./url-data-guard.js";
import { offlineRefusal } from "../../../llm/offline-network.js";
import type { ToolSecretSource } from "../../../config/tool-secrets.js";
import { describeToolSecretUse } from "../../tool-secret-use.js";
import { checkHttpSecrets, fillHttpSecretHeaders } from "./http-request-secrets.js";

export type { HttpMethod } from "./http-request-fetch.js";
export { parseCurlOutput } from "./http-request-fetch.js";
export { maskHeaderValue } from "./http-request-preview.js";

type RunCommandFn = (
  cmd: string,
  args: string[],
  opts: CommandOptions,
) => Promise<CommandResult>;

export interface OsHttpRequestOptions extends DangerousToolOptions {
  config: Pick<AtomicAgentConfig, "http">;
  runCommand?: RunCommandFn;
  /** Injectable DNS lookup for SSRF tests (mirrors os.web.fetch). */
  lookup?: HostLookup;
  /** Sites a chat already used under `http.urlDataGuard: "strict"` (ATO-1377). Defaults to the shared store. */
  urlSendSites?: UrlSendSites;
  /**
   * `agent.security.argScanThreshold` (ATO-2505), read live: at or above
   * it a secret in the body or query asks at every level. Absent: 0.7.
   */
  argScanThreshold?: () => number;
  /** Tool secrets a header value may name as `{{secret:NAME}}` (ATO-2530). Omitted: none. */
  secrets?: ToolSecretSource;
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
    untrustedOutput: "an HTTP response",
    description:
      "Raw HTTP GET or POST via the system `curl` binary for APIs and machine-readable endpoints (JSON, XML, plain text). Returns the response body verbatim — no HTML extraction or cleanup. To read a human web page as markdown/text, use `os.web.fetch` instead. Blocks private/internal addresses (SSRF) like `os.web.fetch`, pins DNS with curl `--resolve`, and re-validates each redirect hop. Host allowlist and approval policy come from `config.http`. Body is capped at `config.http.maxResponseBytes`. Retries transient failures (429/502/503/504 and connection timeouts) with exponential backoff, honouring `Retry-After`; a POST is only retried when the server explicitly invites it, so a request is never double-submitted.",
    readonly: false,
    async run(rawArgs, ctx) {
      const httpCfg = options.config.http;
      if (!httpCfg.enabled) {
        throw new Error(
          "os.http.request: disabled by config (`http.enabled = false`).",
        );
      }
      const args = parseArgs(rawArgs, httpCfg.defaultTimeoutMs);
      // `{{secret:NAME}}` in a header value (ATO-2530): refused before
      // any question unless every name is a configured tool secret.
      const secretUse = checkHttpSecrets(args, options.secrets);
      if (!secretUse.ok) {
        return compressToolResult({
          tool: "os.http.request",
          status: "error",
          output: `os.http.request: ${secretUse.message}`,
          details: { url: args.url, method: args.method },
        });
      }
      const secretNames = secretUse.names;
      // ATO-1084: refused before approval, DNS or curl while offline.
      const offline = offlineRefusal(args.urlObj, "os.http.request");
      if (offline) {
        return compressToolResult({
          tool: "os.http.request",
          status: "error",
          output: offline.message,
          details: {
            url: args.url,
            method: args.method,
            blocked: true,
            offline: true,
            host: offline.host,
          },
        });
      }
      if (!hostAllowed(args.urlObj.hostname, httpCfg.hostAllowlist)) {
        throw new Error(
          `os.http.request: host ${args.urlObj.hostname} is not in config.http.hostAllowlist`,
        );
      }
      // ATO-1377: a GET whose address carries a lot of data (or, under
      // `"strict"`, the chat's first request to a site) asks like a POST.
      // `approvalMode: "never"` is the operator saying no HTTP prompts.
      const urlCheck =
        args.method === "GET" && httpCfg.approvalMode !== "never"
          ? checkUrlSend(
              httpCfg.urlDataGuard ?? DEFAULT_URL_DATA_GUARD,
              args.url,
              ctx.sessionId,
              options.urlSendSites,
            )
          : null;
      // ATO-2505: a secret in the body or query asks whatever the mode;
      // a sure one asks at every level, bypass included.
      const secret = httpSecretFinding(args.urlObj, args.body);
      const secretAsksEveryLevel =
        secret !== null && secret.confidence >= readArgScanThreshold(options.argScanThreshold);
      if (
        needsApproval(httpCfg.approvalMode, args.method) ||
        heldForOutsideContent(options, httpCfg, ctx.sessionId) ||
        urlCheck !== null ||
        secret !== null ||
        // A request handed a secret always asks, even under "never".
        secretNames.length > 0
      ) {
        // Every text the prompt (and the ledger) shows has secrets in the
        // query, fragment and body masked (ATO-1471).
        const shownUrl = maskUrlSecrets(args.url);
        await requireApproval(
          options,
          {
            sessionId: ctx.sessionId,
            tool: "os.http.request",
            // A secret asks as `shell_secret` like a command that uses
            // one: never granted, silent only at full trust (ATO-2530).
            category:
              secretNames.length > 0 ? "shell_secret"
              : urlCheck !== null || secret !== null ? "http_write"
              : httpApprovalCategory(args.method),
            reason:
              (urlCheck !== null
                ? urlSendReason(shownUrl, urlCheck)
                : `${args.method} ${shownUrl}`) + (secret !== null ? ` (${secret.reason})` : "") +
              describeToolSecretUse(secretNames, "when it is sent"),
            ...(secret !== null ? { securityFinding: secret } : {}),
            ...(secretAsksEveryLevel ? { askEveryLevel: true as const } : {}),
            preview: buildHttpApprovalPreview(args),
            affectedResources: [shownUrl],
            // "Allow for this session" and "Allow always" cover this
            // origin only (ATO-1182, ATO-1471).
            ...(secretNames.length > 0 ? {} : { grantKey: args.urlObj.origin }),
          },
          ctx.signal,
        );
        if (urlCheck !== null) noteUrlSendAllowed(urlCheck, ctx.sessionId, options.urlSendSites);
      } else {
        // A request that asks nobody (a GET under "writes", anything
        // under "never") still meets the person's security rules
        // (ATO-2111): its URL alone can carry data out.
        const shownUrl = maskUrlSecrets(args.url);
        await requireGuardOnShortcut(
          options,
          {
            sessionId: ctx.sessionId,
            tool: "os.http.request",
            category: httpApprovalCategory(args.method),
            reason: `${args.method} ${shownUrl}`,
            preview: buildHttpApprovalPreview(args),
            affectedResources: [shownUrl],
          },
          ctx.signal,
        );
      }

      // After approval, and only into what curl sends: the result,
      // details and every record keep the placeholders.
      let sentHeaders = args.headers;
      if (secretNames.length > 0 && options.secrets !== undefined) {
        const filled = await fillHttpSecretHeaders(args.headers, secretNames, options.secrets);
        if (!filled.ok) {
          return compressToolResult({
            tool: "os.http.request",
            status: "error",
            output: `os.http.request: ${filled.message}`,
            details: { url: args.url, method: args.method },
          });
        }
        sentHeaders = filled.headers;
      }

      let guarded;
      try {
        guarded = await executeGuardedHttpRequest(
          args.url,
          {
            method: args.method,
            headers: sentHeaders,
            ...(secretUse.headerNames.length > 0
              ? { originOnlyHeaders: secretUse.headerNames }
              : {}),
            body: args.body,
            timeoutMs: args.timeoutMs,
            followRedirects: args.followRedirects,
          },
          {
            runCommand,
            lookup: options.lookup,
            cwd: ctx.workingDir,
            signal: ctx.signal,
            maxResponseBytes: httpCfg.maxResponseBytes,
          },
        );
      } catch (err) {
        if (err instanceof CurlUnavailableError) {
          return compressToolResult({
            tool: "os.http.request",
            status: "error",
            output: err.message,
            details: { url: args.url, method: args.method },
          });
        }
        if (err instanceof SsrfBlockedError) {
          return compressToolResult({
            tool: "os.http.request",
            status: "error",
            output: err.message,
            details: {
              url: args.url,
              method: args.method,
              blocked: true,
              host: err.host,
            },
          });
        }
        if (isCurlTransportError(err)) {
          return compressToolResult({
            tool: "os.http.request",
            status: "error",
            output: err.message,
            details: {
              exitCode: err.exitCode,
              stderr: err.stderr,
              url: args.url,
              method: args.method,
              command: err.command,
            },
          });
        }
        throw err;
      }

      if (guarded.redirectNotFollowed !== undefined) {
        const target = new URL(guarded.redirectNotFollowed);
        return compressToolResult({
          tool: "os.http.request",
          status: "error",
          output:
            `os.http.request: ${guarded.finalUrl} answered HTTP ${guarded.status} with a redirect to ${target.host} (${guarded.redirectNotFollowed}). ` +
            `The redirect was not followed, so the ${args.method} and its body were not sent there: a request body only goes to the host it was made for (${args.urlObj.host}). ` +
            `If that host is expected, make a new os.http.request to ${guarded.redirectNotFollowed}; it goes through approval like any other request.`,
          details: {
            url: args.url,
            finalUrl: guarded.finalUrl,
            method: args.method,
            status: guarded.status,
            redirectNotFollowed: guarded.redirectNotFollowed,
            redirectChain: guarded.redirectChain,
            command: guarded.command,
          },
        }, { maxSummaryLength: 2_000 });
      }

      const isHttpError = guarded.status >= 400;
      return compressToolResult(
        {
          tool: "os.http.request",
          status: isHttpError ? "error" : "ok",
          output: isHttpError
            ? `HTTP ${guarded.status} ${args.method} ${guarded.finalUrl}`
            : guarded.body,
          details: {
            url: args.url,
            finalUrl: guarded.finalUrl,
            method: args.method,
            status: guarded.status,
            contentType: guarded.contentType,
            sizeDownload: guarded.sizeDownload,
            timeTotalSeconds: guarded.timeTotal,
            truncated: guarded.truncated,
            redirectChain: guarded.redirectChain,
            command: guarded.command,
            ...(isHttpError ? { body: guarded.body } : {}),
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
    typeof rawArgs.method === "string" ? rawArgs.method.toUpperCase() : "GET";
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
      if (
        key.includes("\n") ||
        key.includes("\r") ||
        value.includes("\n") ||
        value.includes("\r")
      ) {
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
/**
 * A GET under `approvalMode: "writes"` skips the gate, but after outside
 * content its URL alone can carry data out (`GET https://x/?d=<secret>`).
 * So on a tainted session with `agent.taintReview` on it asks, and the
 * gate's hold settles it (ATO-618). `"never"` and a host allowlist are the
 * person's own choices and keep answering.
 */
function heldForOutsideContent(
  options: OsHttpRequestOptions,
  httpCfg: AtomicAgentConfig["http"],
  sessionId: string,
): boolean {
  if (httpCfg.approvalMode === "never" || httpCfg.hostAllowlist !== null) return false;
  return options.approvals.holdsForOutsideContent(sessionId, "http");
}

function needsApproval(mode: HttpApprovalMode, method: HttpMethod): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return method !== "GET";
}

/** Methods that only read; any other one sends data out. */
const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The approval category a request asks under: a read stays `http`
 * (silent from level 3), anything that sends data asks as `http_write`
 * (silent from level 4, never answered by an `http` grant or rule).
 * Exported for tests (ATO-1462).
 */
export function httpApprovalCategory(method: string): "http" | "http_write" {
  return READ_ONLY_METHODS.has(method.toUpperCase()) ? "http" : "http_write";
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
