import type { IncomingMessage, ServerResponse } from "node:http";
import { openaiError, type OpenAiErrorPayload } from "./openai-errors.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import type { ApprovalBus } from "./approval-bus.js";
import type { CompletionRegistry } from "./completion-registry.js";
import type { TurnHub } from "./turn-hub.js";

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
  turnHub: TurnHub;
  completionRegistry: CompletionRegistry;
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
 * Enforce the optional bearer-token auth. Returns `true` when the
 * caller may proceed. When auth fails the response is closed with a
 * 401 and the handler must bail out. When `apiKey` is `null` auth is
 * disabled entirely — useful for local loopback use and the default
 * when the operator did not pass `--api-key`.
 */
export function enforceAuth(
  req: IncomingMessage,
  res: ServerResponse,
  apiKey: string | null,
): boolean {
  if (apiKey === null) return true;
  const token = getBearerToken(req);
  if (token === apiKey) return true;
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
  return false;
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
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new BodyTooLargeError(total);
    }
    chunks.push(buf);
  }
  if (total === 0) return {} as T;
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BodyParseError(`invalid JSON: ${message}`);
  }
}

export class BodyTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(`request body exceeds ${MAX_JSON_BODY_BYTES} bytes (got ${bytes})`);
    this.name = "BodyTooLargeError";
  }
}

export class BodyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BodyParseError";
  }
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
 * Start an SSE response and return a writer. Headers follow the OpenAI
 * streaming convention; we also disable proxy buffering so tokens are
 * flushed as they arrive (nginx reads `X-Accel-Buffering: no`).
 */
export function beginSse(
  res: ServerResponse,
  extraHeaders: Record<string, string> = {},
): SseWriter {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
    ...extraHeaders,
  });
  let closed = false;
  res.on("close", () => {
    closed = true;
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
      res.end();
    },
    get closed() {
      return closed;
    },
  };
}
