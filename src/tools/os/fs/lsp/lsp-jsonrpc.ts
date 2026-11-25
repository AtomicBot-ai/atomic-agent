/**
 * The smallest JSON-RPC 2.0 a language-server client needs: the LSP
 * base protocol's `Content-Length` framing over a pair of streams,
 * requests with a timeout, notifications both ways, and a plain answer
 * to the few requests a server sends the client.
 *
 * Hand-written instead of `vscode-jsonrpc`: the client only ever opens a
 * document, changes it and reads `publishDiagnostics`, and the agent
 * ships without new dependencies.
 */
import type { Readable, Writable } from "node:stream";

/** A message larger than this is a broken server, not diagnostics. */
export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

const HEADER_END = "\r\n\r\n";

export type NotificationHandler = (method: string, params: unknown) => void;

export interface JsonRpcConnection {
  request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<T>;
  notify(method: string, params: unknown): void;
  onNotification(handler: NotificationHandler): void;
  /** Rejects every pending request; later calls are no-ops or reject. */
  dispose(reason?: string): void;
  readonly disposed: boolean;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Encode one message with its `Content-Length` header. */
export function encodeMessage(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}${HEADER_END}${body}`;
}

/**
 * Splits a byte stream into framed messages. Returns the parsed bodies
 * and keeps the remainder; throws on a frame it cannot trust.
 */
export class MessageReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: unknown[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_END);
      if (headerEnd === -1) {
        if (this.buffer.length > 8192) throw new Error("LSP header too long");
        return out;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /(?:^|\r\n)content-length:\s*(\d+)/i.exec(header);
      if (match === null) throw new Error("LSP frame without Content-Length");
      const length = Number.parseInt(match[1] ?? "", 10);
      if (!Number.isSafeInteger(length) || length > MAX_MESSAGE_BYTES) {
        throw new Error(`LSP frame too large (${match[1]} bytes)`);
      }
      const start = headerEnd + HEADER_END.length;
      if (this.buffer.length < start + length) return out;
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      out.push(JSON.parse(body));
    }
  }
}

/**
 * The client's answer to a request the server sent. `workspace/configuration`
 * gets one `null` per item (use the server's defaults); everything else
 * (`client/registerCapability`, `window/workDoneProgress/create`, …) a
 * `null` result, which every server accepts.
 */
export function answerServerRequest(method: string, params: unknown): unknown {
  if (method === "workspace/configuration") {
    const items = (params as { items?: unknown } | null)?.items;
    return Array.isArray(items) ? items.map(() => null) : [];
  }
  return null;
}

export function createJsonRpcConnection(
  input: Readable,
  output: Writable,
): JsonRpcConnection {
  const reader = new MessageReader();
  const pending = new Map<number, Pending>();
  const handlers: NotificationHandler[] = [];
  let nextId = 1;
  let disposed = false;

  const write = (message: unknown): void => {
    if (disposed || output.destroyed || !output.writable) return;
    output.write(encodeMessage(message));
  };

  const dispose = (reason = "LSP connection closed"): void => {
    if (disposed) return;
    disposed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  };

  const dispatch = (raw: unknown): void => {
    if (raw === null || typeof raw !== "object") return;
    const msg = raw as {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    if (typeof msg.method === "string") {
      if (msg.id !== undefined) {
        write({
          jsonrpc: "2.0",
          id: msg.id,
          result: answerServerRequest(msg.method, msg.params),
        });
        return;
      }
      for (const handler of handlers) handler(msg.method, msg.params);
      return;
    }
    if (typeof msg.id !== "number") return;
    const entry = pending.get(msg.id);
    if (entry === undefined) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error !== undefined) {
      entry.reject(new Error(msg.error.message ?? "LSP request failed"));
    } else {
      entry.resolve(msg.result ?? null);
    }
  };

  input.on("data", (chunk: Buffer | string) => {
    if (disposed) return;
    try {
      const messages = reader.push(
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
      );
      for (const message of messages) dispatch(message);
    } catch (err) {
      dispose(err instanceof Error ? err.message : String(err));
    }
  });
  input.on("close", () => dispose());
  input.on("error", () => dispose());
  output.on("error", () => dispose());

  return {
    request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
      if (disposed) return Promise.reject(new Error("LSP connection closed"));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`LSP ${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
          timer,
        });
        write({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method: string, params: unknown): void {
      write({ jsonrpc: "2.0", method, params });
    },
    onNotification(handler: NotificationHandler): void {
      handlers.push(handler);
    },
    dispose,
    get disposed() {
      return disposed;
    },
  };
}
