/**
 * How Linear events reach the channel (ATO-2464): the signed webhook
 * server, or the poller when there is no public address. Both have the
 * same `listen` / `close` surface, so the channel's lifecycle does not
 * care which one runs.
 */

import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { LinearApi } from "./linear-api.js";
import { LinearPoller, type LinearPollerDeps } from "./linear-poller.js";
import { LinearServer, type LinearServerDeps } from "./linear-server.js";
import type { LinearWebhookPayload } from "./linear-types.js";

export interface LinearEndpoint {
  listen(): Promise<void>;
  close(): Promise<void>;
}

export const LINEAR_DEFAULT_POLL_MS = 60_000;

export interface LinearEndpointOptions {
  /** The webhook signing secret; `null` means polling. */
  secret: string | null;
  api: Pick<LinearApi, "query">;
  port: number;
  pollMs?: number;
  cursorPath: string;
  onEvent: (payload: LinearWebhookPayload, delivery: string | undefined) => void;
  assignee: () => string | null;
  onFatal: (message: string) => void;
  logger: StructuredLogger;
  createEndpoint?: (deps: LinearServerDeps) => LinearEndpoint;
  createPoller?: (deps: LinearPollerDeps) => LinearEndpoint;
}

export function createLinearEndpoint(opts: LinearEndpointOptions): LinearEndpoint {
  const warn = (m: string, c?: Record<string, unknown>): void => opts.logger.warn(m, c);
  if (opts.secret === null) {
    const deps: LinearPollerDeps = {
      api: opts.api,
      intervalMs: opts.pollMs ?? LINEAR_DEFAULT_POLL_MS,
      cursorPath: opts.cursorPath,
      onEvent: opts.onEvent,
      assignee: opts.assignee,
      onFatal: opts.onFatal,
      logger: { warn },
    };
    opts.logger.info("linear: polling Linear for comments (no public address needed)", {
      everySeconds: Math.round(deps.intervalMs / 1000),
    });
    return opts.createPoller?.(deps) ?? new LinearPoller(deps);
  }
  const deps: LinearServerDeps = { port: opts.port, secret: opts.secret, onEvent: opts.onEvent, logger: { warn } };
  return opts.createEndpoint?.(deps) ?? new LinearServer(deps);
}
