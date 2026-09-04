/**
 * Decide whether this boot mounts Composio, and with what server config.
 *
 * The whole gate lives here: no key (or `composio.enabled: false`) and
 * the function returns `undefined`, bootstrap adds no server, and not
 * one Composio tool is ever registered — the model cannot see or call
 * something that was never mounted.
 *
 * Failure is **soft** by design. Composio being unreachable, rate
 * limiting, or rejecting a stale key must never stop the agent from
 * starting: the operator's shell, files and browser have nothing to do
 * with a third-party SaaS broker. A failure logs a warning and the boot
 * continues exactly as it would with no key at all.
 */

import { buildComposioServerConfig } from "./build-composio-server-config.js";
import { ensureComposioSession } from "./ensure-composio-session.js";
import { persistComposioSession } from "./persist-composio-session.js";
import { resolveComposioApiKey } from "./resolve-composio-key.js";
import type { ComposioConfig } from "../config/config-schema.js";
import type { McpServerConfig } from "../mcp/mcp-types.js";

/** Minimal logger shape — avoids importing the tracing module here. */
export interface ComposioResolveLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
}

export interface ResolveComposioServerOptions {
  composio: ComposioConfig;
  /** Absolute path of `<stateDir>/config.json`, for the session cache. */
  userConfigFile: string;
  logger?: ComposioResolveLogger;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Skip the cached session and mint a new one. */
  forceRefresh?: boolean;
}

export async function resolveComposioServerConfig(
  opts: ResolveComposioServerOptions,
): Promise<McpServerConfig | undefined> {
  if (!opts.composio.enabled) return undefined;
  const apiKey = resolveComposioApiKey({
    apiKeyEnv: opts.composio.apiKeyEnv,
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });
  if (apiKey === undefined) return undefined;

  try {
    const session = await ensureComposioSession({
      apiKey,
      cache: {
        userId: opts.composio.userId,
        sessionId: opts.composio.sessionId,
        mcpUrl: opts.composio.mcpUrl,
      },
      persist: (next) => {
        persistComposioSession(opts.userConfigFile, next);
      },
      ...(opts.forceRefresh === undefined
        ? {}
        : { forceRefresh: opts.forceRefresh }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
    if (session.created) {
      opts.logger?.info("composio session created", {
        sessionId: session.sessionId,
        tools: session.toolNames.length,
      });
    }
    return buildComposioServerConfig({ session, apiKey });
  } catch (err) {
    opts.logger?.warn("composio unavailable; continuing without it", {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
