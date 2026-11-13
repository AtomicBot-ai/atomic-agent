/**
 * The inbound Bot Framework endpoint for the Teams channel (ATO-506).
 *
 * A small `node:http` server bound to 127.0.0.1 only: the user's own
 * tunnel (cloudflared, ngrok, Dev Tunnels, ...) forwards the public
 * messaging endpoint to it. Every request must carry a Bot Framework
 * JWT that `TeamsJwtVerifier` accepts, or it gets a 401 and is never
 * looked at again. An accepted activity is answered 200 straight away
 * (Bot Framework retries a slow endpoint) and handed to `onActivity`
 * after the response is written.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { TeamsAuthError, type TeamsJwtVerifier } from "./msteams-jwt.js";
import { MSTEAMS_MESSAGES_PATH, type TeamsActivity } from "./msteams-types.js";

/** Activities are small; anything bigger is not from Bot Framework. */
export const MAX_BODY_BYTES = 256 * 1024;

export interface TeamsRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: string;
}

export interface TeamsResponse {
  status: number;
  /** The activity to dispatch once the response is written; only on 200. */
  activity?: TeamsActivity;
}

/**
 * Decide one request. Pure apart from the verifier, so the auth rules
 * are tested without a socket.
 */
export async function handleTeamsRequest(
  req: TeamsRequest,
  verifier: Pick<TeamsJwtVerifier, "verify">,
): Promise<TeamsResponse> {
  const path = (req.url ?? "").split("?")[0];
  if (path !== MSTEAMS_MESSAGES_PATH) return { status: 404 };
  if (req.method !== "POST") return { status: 405 };
  let activity: TeamsActivity;
  try {
    const parsed = JSON.parse(req.body) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { status: 400 };
    activity = parsed as TeamsActivity;
  } catch {
    // Unauthenticated garbage gets the same answer as a bad token.
    return { status: req.authorization ? 400 : 401 };
  }
  try {
    await verifier.verify(req.authorization, activity);
  } catch (err) {
    if (err instanceof TeamsAuthError) return { status: 401 };
    throw err;
  }
  return { status: 200, activity };
}

export interface TeamsServerDeps {
  port: number;
  verifier: Pick<TeamsJwtVerifier, "verify">;
  onActivity: (activity: TeamsActivity) => void;
  logger: { warn(msg: string, ctx?: Record<string, unknown>): void };
}

export class TeamsServer {
  private server: Server | null = null;

  constructor(private readonly deps: TeamsServerDeps) {}

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
        server.on("error", (err) => this.deps.logger.warn("msteams: server error", { error: err.message }));
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
      const outcome = await handleTeamsRequest(
        { method: req.method, url: req.url, authorization: req.headers.authorization, body },
        this.deps.verifier,
      );
      respond(res, outcome.status);
      if (outcome.activity) {
        const activity = outcome.activity;
        setImmediate(() => this.deps.onActivity(activity));
      }
    } catch (err) {
      this.deps.logger.warn("msteams: inbound request failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) respond(res, 500);
    }
  }
}

function respond(res: ServerResponse, status: number): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(status === 200 ? "{}" : "");
}

/** The request body as text, or `null` past `MAX_BODY_BYTES`. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      if (!tooBig) chunks.push(chunk);
    });
    req.on("end", () => resolve(tooBig ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
