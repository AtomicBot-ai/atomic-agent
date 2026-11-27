import type { IncomingMessage, ServerResponse } from "node:http";

import { BodyTooLargeError, getHeader, onClientGone, sendJson } from "./request-context.js";

/**
 * Pass one request straight to the local model server and stream its
 * answer back unchanged. Shared by the share routes (`/raw/v1`, ATO-2336)
 * and the launch routes (`/local/v1`, ATO-2447). Only the content type and
 * cache headers of the answer reach the caller; the upstream key is sent
 * to the model server only and never written back.
 */

/** `http://h:p`, `http://h:p/`, `http://h:p/v1` all give `http://h:p/v1<path>`. */
export function upstreamV1Url(baseUrl: string, path: string): string {
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${root}/v1${path}`;
}

/** Headers of the model's answer that the caller sees; nothing else is copied. */
const PASSED_RESPONSE_HEADERS = ["content-type", "cache-control"];

export interface ForwardInput {
  method: "GET" | "POST";
  url: string;
  /** Sent to the model server only; never written to the caller. */
  upstreamKey: string | null;
  body: Buffer | undefined;
  doFetch: typeof fetch;
  /** What the caller gets when the model server cannot be reached (status 502). */
  unreachable: unknown;
  /**
   * ATO-2447: the answer for an upstream 404, when the route has a clearer
   * one than the model server's own (an engine too old for this API).
   */
  notFound?: unknown;
}

export async function forwardToModel(req: IncomingMessage, res: ServerResponse, input: ForwardInput): Promise<void> {
  const abort = new AbortController();
  onClientGone(res, () => abort.abort());
  const headers: Record<string, string> = { accept: getHeader(req, "accept") ?? "application/json" };
  if (input.body !== undefined) headers["content-type"] = "application/json";
  if (input.upstreamKey) headers.authorization = `Bearer ${input.upstreamKey}`;

  let upstream: Response;
  try {
    upstream = await input.doFetch(input.url, {
      method: input.method,
      headers,
      ...(input.body !== undefined ? { body: new Uint8Array(input.body) } : {}),
      signal: abort.signal,
    });
  } catch {
    if (abort.signal.aborted) return;
    sendJson(res, 502, input.unreachable);
    return;
  }

  if (upstream.status === 404 && input.notFound !== undefined) {
    await upstream.body?.cancel().catch(() => undefined);
    sendJson(res, 404, input.notFound);
    return;
  }

  const outHeaders: Record<string, string> = {};
  for (const name of PASSED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) outHeaders[name] = value;
  }
  if ((outHeaders["content-type"] ?? "").startsWith("text/event-stream")) {
    outHeaders["cache-control"] = "no-cache, no-transform";
    outHeaders["x-accel-buffering"] = "no";
  }
  res.writeHead(upstream.status, outHeaders);
  res.flushHeaders?.();
  if (!upstream.body) {
    res.end();
    return;
  }
  try {
    for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
      if (res.destroyed) break;
      res.write(chunk);
    }
  } catch {
    // The model or the caller went away mid-answer; nothing more to send.
  } finally {
    // A caller that left stops the model's generation too.
    if (res.destroyed && !abort.signal.aborted) abort.abort();
    if (!res.writableEnded) res.end();
  }
}

/**
 * The request body, up to `maxBytes`. The launch routes carry a coding
 * CLI's whole conversation and tool list, which outgrows the 1 MiB cap of
 * the agent routes; past `maxBytes` the router answers 413 as usual.
 */
export async function readBodyUpTo(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > maxBytes) throw new BodyTooLargeError(total);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
