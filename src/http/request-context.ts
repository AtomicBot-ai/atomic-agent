import type { IncomingMessage, ServerResponse } from "node:http";
import { openaiError, type OpenAiErrorPayload } from "./openai-errors.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import type { ApprovalBus } from "./approval-bus.js";
import type { CompletionRegistry } from "./completion-registry.js";
import type { UndeliveredSteerStore } from "./undelivered-steers.js";
import { throttleAddress, type AuthThrottle } from "./auth-throttle.js";
import type { McpElicitationBroker } from "../mcp/mcp-elicitation-broker.js";
import { secretEquals } from "./secret-equal.js";

/**
 * Small, dependency-free helpers that every HTTP route needs. Kept in
 * one file instead of spreading read/write primitives across routes.
 */

export const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;

/**
 * Per-request context handed to every route handler. Populated by the
 * router after URL parsing and auth. Handlers should never pull state
 * off the runtime in ways that bypass the approval/toolRegistry layers.
 */
export interface HandlerContext {
  runtime: AgentRuntime;
  apiKey: string | null;
  params: Record<string, string>;
  approvalBus: ApprovalBus;
  completionRegistry: CompletionRegistry;
  /**
   * Where a steer that the runtime accepted but never delivered ends
   * up. Written by whichever route ran the turn, read by
   * `GET /api/sessions/{id}/steer`.
   */
  undeliveredSteers: UndeliveredSteerStore;
  /**
   * ATO-1492: open MCP elicitation questions (a server asking the person
   * to confirm or fill a small form). Set only by a host that wired the
   * broker into the runtime as `onMcpElicitation` (serve does).
   */
  elicitations?: McpElicitationBroker;
  /**
   * ATO-2308: the paired phone whose cookie signed this request in; unset
   * for the serve key and named tokens. Routes that must not let a phone
   * make a lasting change check it.
   */
  pairedDevice?: { readonly id: string; readonly name: string };
}

export type HttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerContext,
) => Promise<void> | void;

export function getHeader(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Extract the raw bearer token from the `Authorization` header. Returns
 * `null` if the header is missing or does not start with `Bearer `.
 */
export function getBearerToken(req: IncomingMessage): string | null {
  const header = getHeader(req, "authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Enforce the bearer-token auth. Returns `true` when the caller may
 * proceed. When auth fails the response is closed with a 401 and the
 * handler must bail out. `apiKey` is `null` only on a server built with
 * `unauthenticated: true` (tests, an embedder that says so); `serve`
 * always has a key, generated on the first run when none is given.
 */
export function enforceAuth(
  req: IncomingMessage,
  res: ServerResponse,
  apiKey: string | null,
  throttle?: AuthThrottle,
): boolean {
  if (apiKey === null) return true;
  const address = throttleAddress(req);
  /* ATO-1126: an address that kept guessing waits, and the comparison is
     constant-time, so the token cannot be read back from response timing. */
  const wait = throttle ? throttle.retryAfter(address) : 0;
  if (wait > 0) {
    sendAuthThrottled(res, wait);
    return false;
  }
  /* ATO-1080: Anthropic clients (Claude Code with ANTHROPIC_API_KEY) send
     the key as `x-api-key` instead of a bearer token. Same key, same check. */
  if (secretEquals(getBearerToken(req) ?? getHeader(req, "x-api-key"), apiKey)) {
    throttle?.succeeded(address);
    return true;
  }
  throttle?.failed(address);
  sendInvalidApiKey(res);
  return false;
}

/** The 429 of an address that kept sending wrong keys (ATO-1126). */
export function sendAuthThrottled(res: ServerResponse, waitSeconds: number): void {
  sendJson(
    res,
    429,
    openaiError("Too many wrong API keys from this address; try again later", "invalid_request_error", null, "auth_throttled"),
    { "retry-after": String(waitSeconds) },
  );
}

/** The 401 of a missing or unknown key. */
export function sendInvalidApiKey(res: ServerResponse): void {
  sendJson(
    res,
    401,
    openaiError(
      "Invalid or missing API key",
      "invalid_request_error",
      null,
      "invalid_api_key",
    ),
  );
}

export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body).toString(),
    ...extraHeaders,
  });
  res.end(body);
}

export function sendError(
  res: ServerResponse,
  status: number,
  payload: OpenAiErrorPayload,
): void {
  sendJson(res, status, payload);
}

/**
 * Read the request body up to `MAX_JSON_BODY_BYTES` and parse as JSON.
 * Throws on oversize or malformed payloads so route handlers can funnel
 * those into OpenAI-style 400 responses.
 */
export async function readJsonBody<T = unknown>(
  req: IncomingMessage,
): Promise<T> {
  return parseJsonBody<T>(await readRawBody(req));
}

/**
 * Read the exact request bytes, capped at `maxBytes` (`MAX_JSON_BODY_BYTES`
 * unless a route passes its own). Routes that verify a signature over the
 * body (signed webhooks) read it this way first and parse it with
 * `parseJsonBody` afterwards. ATO-2483: only the shared model route passes
 * a larger cap, and only after its key check.
 */
export async function readRawBody(req: IncomingMessage, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > maxBytes) {
      throw new BodyTooLargeError(total, maxBytes);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Parse bytes from `readRawBody`; an empty body is `{}`. */
export function parseJsonBody<T = unknown>(raw: Buffer): T {
  if (raw.length === 0) return {} as T;
  try {
    return JSON.parse(raw.toString("utf8")) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BodyParseError(`invalid JSON: ${message}`);
  }
}

export class BodyTooLargeError extends Error {
  constructor(
    public readonly bytes: number,
    public readonly limit: number = MAX_JSON_BODY_BYTES,
  ) {
    super(`request body exceeds ${limit} bytes (got ${bytes})`);
    this.name = "BodyTooLargeError";
  }
}

export class BodyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyParseError";
  }
}

/**
 * Call `onGone` once if the client drops the connection before the
 * response has been ended. Listens on `res`, never on `req`: since Node
 * 16 an `IncomingMessage` destroys itself and emits `close` as soon as
 * its body has been consumed, so a `req.on("close")` attached after
 * `readJsonBody` has already missed its only event and never fires on a
 * later disconnect. A turn wired that way outlived every client that
 * gave up on it — model still generating, steers still accepted.
 */
export function onClientGone(res: ServerResponse, onGone: () => void): void {
  if (res.writableEnded) return;
  if (res.destroyed) {
    onGone();
    return;
  }
  res.once("close", () => {
    if (!res.writableEnded) onGone();
  });
}

export interface SseWriter {
  /** Write an SSE frame. `event` is the optional `event:` field name. */
  writeEvent(event: string | null, payload: unknown): boolean;
  /** Write a raw terminator frame like `data: [DONE]`. */
  writeRaw(chunk: string): boolean;
  /** Close the response stream. */
  close(): void;
  /** `true` once the underlying response has been closed. */
  readonly closed: boolean;
}

/**
 * How often a long-lived SSE stream writes a comment line (`: keepalive`)
 * when asked to. A stream can be silent for minutes on end: a turn parked
 * on an approval nobody has answered yet, the approval events stream
 * between requests. Node's fetch (undici, the desktop's client) drops a
 * response body after 300 s without a byte and reports "terminated", which
 * ended the turn under a card the person had not answered yet. A comment
 * is no event: SSE parsers, the OpenAI SDKs' included, skip it.
 */
export const SSE_HEARTBEAT_MS = 15_000;

/**
 * Start an SSE response and return a writer. Headers follow the OpenAI
 * streaming convention; we also disable proxy buffering so tokens are
 * flushed as they arrive (nginx reads `X-Accel-Buffering: no`).
 * `heartbeatMs` writes a comment line at that interval until the stream
 * closes (see `SSE_HEARTBEAT_MS`); without it nothing is written but
 * what the caller writes.
 */
export function beginSse(
  res: ServerResponse,
  extraHeaders: Record<string, string> = {},
  options: { heartbeatMs?: number } = {},
): SseWriter {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...extraHeaders,
  });
  // Send the head now: Node holds it until the first write otherwise, so
  // a client of a stream with nothing to say yet (no pending approval, no
  // question) would not see it open until the first heartbeat. Optional:
  // a test double of the response may not have it.
  res.flushHeaders?.();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  if (options.heartbeatMs && options.heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(": keepalive\n\n");
    }, options.heartbeatMs);
    heartbeat.unref?.();
  }
  const stopHeartbeat = (): void => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };
  res.on("close", () => {
    closed = true;
    stopHeartbeat();
  });
  return {
    writeEvent(event, payload) {
      if (closed) return false;
      const prefix = event ? `event: ${event}\n` : "";
      return res.write(`${prefix}data: ${JSON.stringify(payload)}\n\n`);
    },
    writeRaw(chunk) {
      if (closed) return false;
      return res.write(chunk);
    },
    close() {
      if (closed) return;
      closed = true;
      stopHeartbeat();
      res.end();
    },
    get closed() {
      return closed;
    },
  };
}
