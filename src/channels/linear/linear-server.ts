/**
 * The inbound webhook endpoint for the Linear channel (ATO-2324).
 *
 * A small `node:http` server bound to 127.0.0.1 only: the user's own
 * tunnel (cloudflared, ngrok, ...) forwards the public webhook URL to it,
 * the same arrangement as the Teams endpoint. Every request must carry a
 * `Linear-Signature` that matches the raw body and a fresh
 * `webhookTimestamp`, or it gets a 401 and is never looked at again. An
 * accepted delivery is answered 200 straight away (Linear retries a slow
 * endpoint) and handed to `onEvent` after the response is written.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { checkLinearTimestamp, verifyLinearSignature } from "./linear-signature.js";
import { LINEAR_WEBHOOK_PATH, type LinearWebhookPayload } from "./linear-types.js";

/** Linear payloads are small; anything bigger is not from Linear. */
export const LINEAR_MAX_BODY_BYTES = 512 * 1024;

export interface LinearRequest {
  method: string | undefined;
  url: string | undefined;
  /** The `Linear-Signature` header. */
  signature: string | undefined;
  /** The `Linear-Delivery` header, a uuid per delivery. */
  delivery: string | undefined;
  body: Buffer;
}

export interface LinearResponse {
  status: number;
  /** The event to dispatch once the response is written; only on 200. */
  payload?: LinearWebhookPayload;
  /** Delivery id for replay protection, when Linear sent one. */
  delivery?: string;
}

/**
 * Decide one request. Pure, so the auth rules are tested without a socket.
 * The signature is checked before the body is parsed: unsigned bytes are
 * never interpreted.
 */
export function handleLinearRequest(req: LinearRequest, secret: string, nowMs: number): LinearResponse {
  const path = (req.url ?? "").split("?")[0];
  if (path !== LINEAR_WEBHOOK_PATH) return { status: 404 };
  if (req.method !== "POST") return { status: 405 };
  if (!verifyLinearSignature(req.body, req.signature, secret).ok) return { status: 401 };
  let payload: LinearWebhookPayload;
  try {
    const parsed = JSON.parse(req.body.toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { status: 400 };
    payload = parsed as LinearWebhookPayload;
  } catch {
    return { status: 400 };
  }
  if (!checkLinearTimestamp(payload.webhookTimestamp, nowMs).ok) return { status: 401 };
  return {
    status: 200,
    payload,
    ...(typeof req.delivery === "string" && req.delivery.length > 0 ? { delivery: req.delivery } : {}),
  };
}

export interface LinearServerDeps {
  port: number;
  secret: string;
  onEvent: (payload: LinearWebhookPayload, delivery: string | undefined) => void;
  logger: { warn(msg: string, ctx?: Record<string, unknown>): void };
  now?: () => number;
}

export class LinearServer {
  private server: Server | null = null;

  constructor(private readonly deps: LinearServerDeps) {}

  /** Bind 127.0.0.1:<port>. Rejects on EADDRINUSE and friends. */
  listen(): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = createServer((req, res) => {
      void this.onRequest(req, res);
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server = null;
        reject(err);
      };
      server.once("error", onError);
      server.listen(this.deps.port, "127.0.0.1", () => {
        server.off("error", onError);
        server.on("error", (err) => this.deps.logger.warn("linear: server error", { error: err.message }));
        resolve();
      });
    });
  }

  /** Stop accepting and drop open connections. Idempotent. */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readBody(req);
      if (body === null) {
        respond(res, 413);
        return;
      }
      const outcome = handleLinearRequest(
        {
          method: req.method,
          url: req.url,
          signature: headerOf(req, "linear-signature"),
          delivery: headerOf(req, "linear-delivery"),
          body,
        },
        this.deps.secret,
        (this.deps.now ?? Date.now)(),
      );
      if (outcome.status === 401) this.deps.logger.warn("linear: refused a webhook with a bad signature or timestamp");
      respond(res, outcome.status);
      if (outcome.payload) {
        const payload = outcome.payload;
        const delivery = outcome.delivery;
        setImmediate(() => this.deps.onEvent(payload, delivery));
      }
    } catch (err) {
      this.deps.logger.warn("linear: inbound request failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) respond(res, 500);
    }
  }
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function respond(res: ServerResponse, status: number): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(status === 200 ? "{}" : "");
}

/** The raw request bytes, or `null` past `LINEAR_MAX_BODY_BYTES`. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > LINEAR_MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(tooBig ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
