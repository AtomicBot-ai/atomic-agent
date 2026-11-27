import type { IncomingMessage, ServerResponse } from "node:http";

import { getConfig, readUserConfigFileSync } from "../config/index.js";
import { apiKeyForUrl } from "../local-llm/server/managed-api-key.js";
import { AuthThrottle, isLoopbackAddress } from "./auth-throttle.js";
import { readModelShareKey } from "./model-share-key.js";
import { readModelShareSettings } from "./model-share-settings.js";
import { openaiError } from "./openai-errors.js";
import { createInFlightLimit, type InFlightLimit } from "./raw-model-limit.js";
import {
  getBearerToken,
  getHeader,
  onClientGone,
  readRawBody,
  sendAuthThrottled,
  sendError,
  sendInvalidApiKey,
  type HttpHandler,
} from "./request-context.js";
import { secretEquals } from "./secret-equal.js";
import { remoteMediaProblem } from "./raw-model-body-guard.js";

/**
 * ATO-2336: the local model itself, for other apps and devices.
 *
 * `/v1/chat/completions` on serve runs the agent (tools, memory, a
 * session). These routes run nothing of the agent: they pass an
 * OpenAI-compatible request straight to the local model server the agent
 * uses now (`localModels.url`, the managed llama-server or Atomic Core),
 * add that server's private key on the way, and stream its answer back
 * unchanged. The precedent is LM Studio's "Serve on Local Network", Jan's
 * Local API Server and Ollama's "Expose" switch.
 *
 * - Off by default: with `localModels.managed.share` not `true` every
 *   raw route answers 404, as if it did not exist.
 * - Its own key (model-share-key.ts) and only that key: the serve key and
 *   the named tokens get 401 here, and the share key gets 401 on every
 *   agent route, because the router never compares against it.
 * - One request at a time (raw-model-limit.ts); a second gets 429.
 * - The upstream key is set server-side and never returned.
 */

export const RAW_MODEL_PREFIX = "/raw/v1";

/**
 * ATO-2483: the body cap of the raw route. Every other route keeps
 * `MAX_JSON_BODY_BYTES` (1 MiB); a chat with a photo or two inline as
 * base64 `data:` URLs (the only way remote-media guarding lets media in)
 * is several MiB, so 1 MiB answered 413. 32 MiB holds a handful of phone
 * photos; OpenAI's own image inputs stop at 20 MB per image. The body is
 * read only after the share key was checked (`admit`), and one raw request
 * runs at a time, so an unauthenticated caller cannot make serve hold more
 * than nothing, and an authenticated one at most this much.
 */
export const RAW_MODEL_MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface RawModelUpstream {
  /** Base URL of the model server, e.g. `http://127.0.0.1:19091`. */
  baseUrl: string;
  /** The key that server requires, or `null` for none. */
  apiKey: string | null;
}

export interface RawModelShareDeps {
  /** Whether sharing is switched on now. */
  isEnabled: () => boolean;
  /**
   * ATO-2483: `true` while the mode is "This computer" (local): callers
   * from another address get 404, also on a serve whose own listener is on
   * the network. Omitted: no address check (tests of the other rules).
   */
  localOnly?: () => boolean;
  /** The share key, `null` when none was made. */
  readKey: () => string | null;
  /** Where the model is now. */
  upstream: () => RawModelUpstream;
  fetch?: typeof fetch;
  limit?: InFlightLimit;
  throttle?: AuthThrottle;
}

/**
 * Read from the config file on every request rather than the process
 * cache, so `atomic-agent models share` in another terminal (or `--off`)
 * takes effect on a serve that is already running.
 */
export function isModelShareEnabled(): boolean {
  try {
    const file = readUserConfigFileSync(getConfig().paths.userConfigFile);
    return file?.localModels.managed.share === true;
  } catch {
    return false;
  }
}

export function defaultRawModelShareDeps(): RawModelShareDeps {
  return {
    isEnabled: isModelShareEnabled,
    localOnly: () => readModelShareSettings().mode === "local",
    readKey: () => readModelShareKey(getConfig().paths.stateDir),
    upstream: () => {
      const config = getConfig();
      const baseUrl = config.localModels.url;
      return { baseUrl, apiKey: apiKeyForUrl(baseUrl, config) };
    },
  };
}

/** `http://h:p`, `http://h:p/`, `http://h:p/v1` all give `http://h:p/v1`. */
export function upstreamV1Url(baseUrl: string, path: string): string {
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${root}/v1${path}`;
}

/** Headers of the model's answer that the caller sees; nothing else is copied. */
const PASSED_RESPONSE_HEADERS = ["content-type", "cache-control"];

export interface RawModelHandlers {
  models: HttpHandler;
  chatCompletions: HttpHandler;
}

export function createRawModelHandlers(deps: RawModelShareDeps = defaultRawModelShareDeps()): RawModelHandlers {
  const limit = deps.limit ?? createInFlightLimit();
  const throttle = deps.throttle ?? new AuthThrottle();
  const doFetch = deps.fetch ?? fetch;

  const handle = (method: "GET" | "POST", path: string): HttpHandler => async (req, res) => {
    if (!admit(req, res, deps, throttle)) return;
    const release = limit.tryAcquire();
    if (!release) {
      sendError(
        res,
        429,
        openaiError("The shared model is answering another request; try again in a moment", "rate_limit_error", null, "model_busy"),
      );
      return;
    }
    try {
      const body = method === "POST" ? await readRawBody(req, RAW_MODEL_MAX_BODY_BYTES) : undefined;
      const mediaProblem = remoteMediaProblem(body);
      if (mediaProblem) {
        sendError(res, 400, openaiError(mediaProblem, "invalid_request_error", null, "remote_media_refused"));
        return;
      }
      const target = deps.upstream();
      await forward(req, res, { method, url: upstreamV1Url(target.baseUrl, path), upstreamKey: target.apiKey, body, doFetch });
    } finally {
      release();
    }
  };

  return {
    models: handle("GET", "/models"),
    chatCompletions: handle("POST", "/chat/completions"),
  };
}

/** Switch, key, then the bearer check. `true` when the request may go on. */
function admit(req: IncomingMessage, res: ServerResponse, deps: RawModelShareDeps, throttle: AuthThrottle): boolean {
  // ATO-2483: in local mode a caller from another device sees the route as
  // missing, the same answer as off, before any key is looked at.
  if (!deps.isEnabled() || (deps.localOnly?.() === true && !isLoopbackAddress(req.socket?.remoteAddress ?? ""))) {
    const method = (req.method ?? "GET").toUpperCase();
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    sendError(res, 404, openaiError(`No route for ${method} ${path}`, "invalid_request_error"));
    return false;
  }
  const key = deps.readKey();
  if (key === null) {
    sendError(
      res,
      503,
      openaiError("Model sharing is on but has no key yet; run: atomic-agent models share", "server_error", null, "share_key_missing"),
    );
    return false;
  }
  const address = req.socket?.remoteAddress;
  const wait = throttle.retryAfter(address);
  if (wait > 0) {
    sendAuthThrottled(res, wait);
    return false;
  }
  const sent = getBearerToken(req) ?? getHeader(req, "x-api-key");
  if (!secretEquals(sent, key)) {
    // ATO-2483: only a wrong key counts as a guess. A request with no key
    // (the desktop's Find on my network probing for a shared model) guesses
    // nothing, and counting it locked the real app out with 429.
    if (sent) throttle.failed(address);
    sendInvalidApiKey(res);
    return false;
  }
  throttle.succeeded(address);
  return true;
}

interface ForwardInput {
  method: "GET" | "POST";
  url: string;
  /** Sent to the model server only; never written to the caller. */
  upstreamKey: string | null;
  body: Buffer | undefined;
  doFetch: typeof fetch;
}

async function forward(req: IncomingMessage, res: ServerResponse, input: ForwardInput): Promise<void> {
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
    sendError(
      res,
      502,
      openaiError("The local model is not running; start it in Atomic Agent and try again", "server_error", null, "model_unreachable"),
    );
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
