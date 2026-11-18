/**
 * JSON-RPC 2.0 over newline-delimited JSON on stdio, the transport of
 * the Agent Client Protocol (ATO-543). One JSON object per line, in both
 * directions; either side may send requests, responses and
 * notifications. Hand-written rather than pulled from
 * `@agentclientprotocol/sdk`: the framing is small and the rest of the
 * protocol lives in `acp-server.ts`.
 *
 * Only protocol frames are written to `output`. A line that does not
 * parse gets a `-32700` error with `id: null`, as the spec asks.
 */

import type { Readable, Writable } from "node:stream";
import { isBrokenPipeError } from "../error-reporting/broken-pipe.js";

export type JsonRpcId = string | number;

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

/** Throw from a handler to answer with this code instead of `-32603`. */
export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

export type RequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;
export type NotificationHandler = (method: string, params: unknown) => void;

export interface JsonRpcConnectionOptions {
  input: Readable;
  output: Writable;
  onRequest: RequestHandler;
  onNotification?: NotificationHandler;
  /** Diagnostics only (stderr in the command); never the protocol stream. */
  log?: (message: string) => void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class JsonRpcConnection {
  private buffer = "";
  private nextId = 0;
  private readonly pending = new Map<JsonRpcId, PendingCall>();
  private outputClosed = false;
  private resolveClosed!: () => void;
  /** Resolves when the peer closed our input. */
  readonly closed: Promise<void>;

  constructor(private readonly options: JsonRpcConnectionOptions) {
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    options.input.setEncoding("utf8");
    options.input.on("data", (chunk: string) => this.ingest(chunk));
    options.input.on("end", () => {
      if (this.buffer.trim().length > 0) this.handleLine(this.buffer);
      this.buffer = "";
      this.failPending(new Error("connection closed"));
      this.resolveClosed();
    });
    options.input.on("close", () => this.resolveClosed());
    options.output.on("error", (err) => {
      this.outputClosed = true;
      if (!isBrokenPipeError(err)) options.log?.(`output error: ${String(err)}`);
    });
    options.output.on("close", () => {
      this.outputClosed = true;
    });
  }

  /** Send a request to the peer and wait for its result. */
  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = `a${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      if (!this.write({ jsonrpc: "2.0", id, method, params })) {
        this.pending.delete(id);
        reject(new Error("connection closed"));
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleLine(raw: string): void {
    const line = raw.trim();
    if (line.length === 0) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (err) {
      this.write({
        jsonrpc: "2.0",
        id: null,
        error: { code: JSONRPC_PARSE_ERROR, message: `parse error: ${(err as Error).message}` },
      });
      return;
    }
    if (!isObject(message) || message.jsonrpc !== "2.0") {
      this.write({
        jsonrpc: "2.0",
        id: isObject(message) && isId(message.id) ? message.id : null,
        error: { code: JSONRPC_INVALID_REQUEST, message: "not a JSON-RPC 2.0 message" },
      });
      return;
    }
    if (typeof message.method === "string") {
      if (message.id === undefined) {
        try {
          this.options.onNotification?.(message.method, message.params);
        } catch (err) {
          this.options.log?.(`notification ${message.method} failed: ${String(err)}`);
        }
        return;
      }
      if (!isId(message.id)) {
        this.write({
          jsonrpc: "2.0",
          id: null,
          error: { code: JSONRPC_INVALID_REQUEST, message: "id must be a string or a number" },
        });
        return;
      }
      void this.answer(message.id, message.method, message.params);
      return;
    }
    // A response to one of our requests.
    if (isId(message.id) && ("result" in message || "error" in message)) {
      const call = this.pending.get(message.id);
      if (call === undefined) return;
      this.pending.delete(message.id);
      if ("error" in message && isObject(message.error)) {
        const error = message.error;
        call.reject(
          new JsonRpcError(
            typeof error.code === "number" ? error.code : JSONRPC_INTERNAL_ERROR,
            typeof error.message === "string" ? error.message : "request failed",
            error.data,
          ),
        );
      } else {
        call.resolve(message.result);
      }
      return;
    }
    this.write({
      jsonrpc: "2.0",
      id: isId(message.id) ? message.id : null,
      error: { code: JSONRPC_INVALID_REQUEST, message: "neither a request nor a response" },
    });
  }

  private async answer(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.options.onRequest(method, params);
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (err) {
      const error =
        err instanceof JsonRpcError
          ? { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) }
          : { code: JSONRPC_INTERNAL_ERROR, message: err instanceof Error ? err.message : String(err) };
      this.write({ jsonrpc: "2.0", id, error });
    }
  }

  private failPending(error: Error): void {
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
  }

  /** `false` when the frame could not be written (peer gone). */
  private write(frame: Record<string, unknown>): boolean {
    if (this.outputClosed || this.options.output.destroyed) return false;
    try {
      this.options.output.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch (err) {
      this.outputClosed = true;
      if (!isBrokenPipeError(err)) throw err;
      return false;
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
