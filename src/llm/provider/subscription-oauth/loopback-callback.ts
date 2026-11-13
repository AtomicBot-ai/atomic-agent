import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  OAuthFlowError,
  sanitizeOAuthError,
} from "./oauth-errors.js";
import { statesMatch } from "./pkce.js";

export interface LoopbackCallbackOptions<T> {
  /** Fixed port when the provider pins the redirect URI; 0 or unset = random. */
  port?: number;
  /** Path the provider redirects to, for example "/callback". */
  path: string;
  expectedState: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Runs once for the first valid hit; its outcome settles `result`. */
  onCode: (code: string, signal: AbortSignal) => Promise<T>;
}

export interface LoopbackCallback<T> {
  port: number;
  /** Settles once; the server is closed by then (success, failure, timeout). */
  result: Promise<T>;
  /** Stops waiting, closes the server and rejects `result` with `cancelled`. */
  cancel(): void;
}

const LOOPBACK_HOST = "127.0.0.1";

/**
 * One-shot redirect receiver bound only to the loopback interface. The first
 * request on `path` is the only one processed: a forged `state` fails the
 * attempt, later hits get 409, and the server closes as soon as the attempt
 * settles. Pages never echo query values back to the browser.
 */
export async function openLoopbackCallback<T>(
  options: LoopbackCallbackOptions<T>,
): Promise<LoopbackCallback<T>> {
  if (options.signal?.aborted) throw new OAuthFlowError("cancelled");

  let handled = false;
  let finished = false;
  let resolveResult!: (value: T) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // Keeps a caller that attaches late from tripping unhandled rejection.
  result.catch(() => undefined);
  const exchangeAbort = new AbortController();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
    if (req.method !== "GET" || url.pathname !== options.path) {
      respond(res, 404, "Not found.");
      return;
    }
    if (handled || finished) {
      respond(res, 409, "This sign-in link was already used.");
      return;
    }
    handled = true;
    const params = url.searchParams;
    if (!statesMatch(options.expectedState, params.get("state"))) {
      respond(res, 400, "Sign-in failed: this request did not come from the app.", () =>
        fail(new OAuthFlowError("state_mismatch")),
      );
      return;
    }
    const providerError = params.get("error");
    if (providerError !== null) {
      respond(res, 400, "Sign-in was not completed. Return to the app.", () =>
        fail(
          new OAuthFlowError("authorization_denied", {
            oauthError: sanitizeOAuthError(providerError),
          }),
        ),
      );
      return;
    }
    const code = params.get("code");
    if (!code) {
      respond(res, 400, "Sign-in failed. Return to the app.", () =>
        fail(new OAuthFlowError("missing_code")),
      );
      return;
    }
    options.onCode(code, exchangeAbort.signal).then(
      (value) =>
        respond(res, 200, "Signed in. You can close this tab.", () => succeed(value)),
      (error: unknown) =>
        respond(res, 500, "Sign-in failed. Return to the app.", () =>
          fail(error instanceof Error ? error : new OAuthFlowError("token_request_failed")),
        ),
    );
  });

  const timer = setTimeout(
    () => fail(new OAuthFlowError("callback_timeout")),
    options.timeoutMs,
  );
  const onAbort = () => fail(new OAuthFlowError("cancelled"));
  options.signal?.addEventListener("abort", onAbort, { once: true });

  /** Settles only after the listening socket is closed, so the port is free. */
  function shutdown(settle: () => void): void {
    finished = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    server.close(() => settle());
    server.closeAllConnections();
  }
  function succeed(value: T): void {
    if (finished) return;
    shutdown(() => resolveResult(value));
  }
  function fail(error: Error): void {
    if (finished) return;
    exchangeAbort.abort();
    shutdown(() => rejectResult(error));
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, LOOPBACK_HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch {
    shutdown(() => undefined);
    throw new OAuthFlowError("callback_port_unavailable");
  }

  const { port } = server.address() as AddressInfo;
  return { port, result, cancel: () => fail(new OAuthFlowError("cancelled")) };
}

function respond(
  res: ServerResponse,
  status: number,
  message: string,
  after?: () => void,
): void {
  if (res.destroyed || res.writableEnded) {
    after?.();
    return;
  }
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(message, () => after?.());
}
