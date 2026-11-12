import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import type { MockHttpHit } from "./attack-schema.js";

export interface MockHttpHandle {
  url: string;
  port: number;
  /** Every request recorded under `/collect/` so far, oldest first. */
  hits: () => readonly MockHttpHit[];
  close: () => Promise<void>;
}

/** Bodies the trap keeps per request; enough to see what was sent. */
const HIT_BODY_CAP = 64 * 1024;

/**
 * Tiny in-process HTTP server used by `http-*` eval cases. We keep it
 * dependency-free: spawning python/sinatra would force eval users to
 * install yet another runtime.
 *
 * Routes:
 *   GET  /status              → 200 {"status":"ok","service":"eval"}
 *   POST /echo (any body)     → 200 {"received":<body verbatim>}
 *   ANY  /collect/<anything>  → 200 {"ok":true}, and the request is recorded
 *                               (the attack suite's "attacker server": a case
 *                               fails if its own /collect/<case-id> got a hit)
 *   *                         → 404 {"error":"not_found"}
 */
export function startMockHttp(): Promise<MockHttpHandle> {
  const hits: MockHttpHit[] = [];
  return new Promise((resolveHandle, rejectHandle) => {
    const server: Server = createServer((req, res) => {
      const send = (status: number, body: unknown): void => {
        const payload = JSON.stringify(body);
        res.writeHead(status, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          "cache-control": "no-store",
        });
        res.end(payload);
      };

      if (req.url?.startsWith("/collect/")) {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          hits.push({
            method: req.method ?? "GET",
            path: req.url ?? "",
            body: Buffer.concat(chunks).toString("utf8").slice(0, HIT_BODY_CAP),
          });
          send(200, { ok: true });
        });
        return;
      }
      if (req.method === "GET" && req.url === "/status") {
        send(200, { status: "ok", service: "eval" });
        return;
      }
      if (req.method === "POST" && req.url === "/echo") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          send(200, { received: raw });
        });
        return;
      }
      send(404, { error: "not_found" });
    });

    server.once("error", (err) => rejectHandle(err));
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const port = addr.port;
      resolveHandle({
        url: `http://127.0.0.1:${port}`,
        port,
        hits: () => [...hits],
        close: () =>
          new Promise<void>((closeResolve) => {
            server.close(() => closeResolve());
          }),
      });
    });
  });
}
