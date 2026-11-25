import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { createChatCompletionsHandler } from "./openai-chat-completions.js";
import type { HandlerContext } from "./request-context.js";

/**
 * ATO-1080: the bridge the Anthropic Messages (`/v1/messages`) and OpenAI
 * Responses (`/v1/responses`) routes run on. Each of them translates its
 * request into a `/v1/chat/completions` body, runs the very same handler
 * in-process, and translates what that handler writes (one JSON body, or a
 * strict OpenAI SSE stream with extensions off) back into its own wire
 * format. One turn path, one set of session, approval, cancellation and
 * usage rules: the compat routes only change the envelope.
 */

/** A chat-completions request body, the subset the compat routes produce. */
export interface ChatBridgeBody {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  stream: boolean;
  stream_options?: { include_usage: boolean };
  session_id?: string;
  working_dir?: string;
}

/** What the inner chat-completions handler produced, as it produces it. */
export interface ChatBridgeSink {
  /** A plain JSON answer: the non-stream reply, or an error before any stream. */
  onJson(status: number, headers: Record<string, string>, body: unknown): void;
  /** The inner handler opened its SSE stream (status 200). */
  onStreamStart(headers: Record<string, string>): void;
  /** One `data:` payload of the inner stream, `[DONE]` included. Comments are dropped. */
  onStreamData(data: string): void;
  /** The inner stream ended. */
  onStreamEnd(): void;
}

/**
 * Split an SSE byte stream into the `data:` payloads of its frames. Fed in
 * arbitrary pieces; a frame is complete at a blank line. Frames with no
 * `data:` line (the `: keepalive` heartbeat comment) yield nothing.
 */
export class SseDataParser {
  private buffer = "";

  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      const frame = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const data = frameData(frame);
      if (data !== null) out.push(data);
    }
    return out;
  }

  /** Whatever is left once the stream ended without a closing blank line. */
  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    const data = rest.trim().length > 0 ? frameData(rest) : null;
    return data === null ? [] : [data];
  }
}

function frameData(frame: string): string | null {
  const lines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("data:")) lines.push(line.slice(5).replace(/^ /, ""));
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Stand-in for the `ServerResponse` the inner handler writes to. It covers
 * what the chat-completions handler and its helpers use (`writeHead`,
 * `write`, `end`, `on/once("close")`, `writableEnded`, `destroyed`) and
 * hands everything to the sink. `abort()` is the real client going away:
 * it fires `close` before the end, so the inner turn is cancelled exactly
 * as when a chat-completions client disconnects.
 */
export class CaptureResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  private headers: Record<string, string> = {};
  private streaming = false;
  private readonly chunks: Buffer[] = [];
  private readonly parser = new SseDataParser();

  constructor(private readonly sink: ChatBridgeSink) {
    super();
  }

  writeHead(status: number, headers: Record<string, string | number> = {}): this {
    this.statusCode = status;
    this.headersSent = true;
    for (const [key, value] of Object.entries(headers)) {
      this.headers[key.toLowerCase()] = String(value);
    }
    this.streaming = status === 200 && (this.headers["content-type"] ?? "").includes("text/event-stream");
    if (this.streaming) this.sink.onStreamStart({ ...this.headers });
    return this;
  }

  setHeader(name: string, value: string | number): this {
    this.headers[name.toLowerCase()] = String(value);
    return this;
  }

  write(chunk: string | Buffer): boolean {
    if (this.writableEnded || this.destroyed) return false;
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (this.streaming) {
      for (const data of this.parser.push(buf.toString("utf8"))) this.sink.onStreamData(data);
    } else {
      this.chunks.push(buf);
    }
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (this.writableEnded) return this;
    if (chunk !== undefined && !this.destroyed) this.write(chunk);
    this.writableEnded = true;
    if (this.streaming) {
      for (const data of this.parser.flush()) this.sink.onStreamData(data);
      this.sink.onStreamEnd();
    } else {
      const raw = Buffer.concat(this.chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        body = { error: { message: raw, type: "server_error", param: null, code: null } };
      }
      this.sink.onJson(this.statusCode, { ...this.headers }, body);
    }
    this.emit("finish");
    this.emit("close");
    return this;
  }

  abort(): void {
    if (this.writableEnded || this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

const SESSION_HEADER = "x-atomic-session-id";

/**
 * Run `body` through the chat-completions handler and report what it
 * writes to `sink`. The inner request carries only the session header of
 * the real one: never `X-Atomic-Extensions`, so the stream the bridge
 * parses is strict OpenAI. Resolves once the inner handler returned.
 */
export async function runChatCompletionsBridge(
  realReq: IncomingMessage,
  realRes: ServerResponse,
  ctx: HandlerContext,
  body: ChatBridgeBody,
  sink: ChatBridgeSink,
): Promise<void> {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const innerReq = Readable.from([payload]) as unknown as IncomingMessage;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const session = realReq.headers[SESSION_HEADER];
  if (typeof session === "string" && session.length > 0) headers[SESSION_HEADER] = session;
  Object.assign(innerReq, {
    headers,
    method: "POST",
    url: "/v1/chat/completions",
    socket: realReq.socket,
  });
  const capture = new CaptureResponse(sink);
  const onGone = (): void => {
    if (!realRes.writableEnded) capture.abort();
  };
  realRes.once("close", onGone);
  try {
    await chatHandler(innerReq, capture as unknown as ServerResponse, ctx);
  } finally {
    realRes.off("close", onGone);
  }
}

const chatHandler = createChatCompletionsHandler();

/** The session and completion ids the inner handler put on its headers, to pass on. */
export function passThroughHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const session = headers["x-atomic-session-id"];
  const completion = headers["x-atomic-completion-id"];
  if (session) out["X-Atomic-Session-Id"] = session;
  if (completion) out["X-Atomic-Completion-Id"] = completion;
  return out;
}

/** A chat-completions finish reason, normalised. */
export type ChatFinish = "stop" | "length" | "cancelled";

export function normaliseFinish(value: unknown): ChatFinish {
  return value === "length" ? "length" : value === "cancelled" ? "cancelled" : "stop";
}

/** Token counts pulled off a chat `usage` object; zeros when absent. */
export function readUsage(value: unknown): { input: number; output: number } {
  const usage = (value ?? {}) as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { input: n(usage.prompt_tokens), output: n(usage.completion_tokens) };
}

/** The OpenAI error message out of a chat error envelope, whatever its shape. */
export function readErrorMessage(body: unknown): string {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" ? message : "Unknown error";
}

/** Short random hex for response / item ids. */
export function randomHex(length: number): string {
  let out = "";
  while (out.length < length) out += randomUUID().replace(/-/g, "");
  return out.slice(0, length);
}
