/**
 * Reuse-or-create the Composio tool-router session.
 *
 * Two things must stay stable across restarts:
 *
 *  - the **user id**, because Composio scopes connected accounts to it.
 *    Mint it once and keep it, or every restart would ask the operator
 *    to re-authorise Gmail. It is a random UUID, never the operator's
 *    email — Composio's own docs advise against emails as user ids, and
 *    an email is PII this integration has no reason to hand over.
 *  - the **session id**, so a normal boot costs zero API calls.
 *
 * A cached session that Composio has since dropped surfaces as a failed
 * MCP connect, not as an error here; `forceRefresh` is how the
 * Integrations pane asks for a new one.
 */

import { randomUUID } from "node:crypto";

import {
  createComposioSession,
  type ComposioSession,
} from "./composio-api.js";

/** The three values persisted in `config.composio`. */
export interface ComposioSessionCache {
  userId: string | null;
  sessionId: string | null;
  mcpUrl: string | null;
}

export interface EnsuredComposioSession extends ComposioSession {
  userId: string;
  /** False when the cache was reused and no API call was made. */
  created: boolean;
}

export interface EnsureComposioSessionOptions {
  apiKey: string;
  cache: ComposioSessionCache;
  /** Persist a newly minted id/session. Not called on a cache hit. */
  persist: (next: {
    userId: string;
    sessionId: string;
    mcpUrl: string;
  }) => Promise<void> | void;
  /** Discard the cached session and create a fresh one. */
  forceRefresh?: boolean;
  baseUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Seam for tests; defaults to the real HTTP call. */
  createSession?: typeof createComposioSession;
}

export async function ensureComposioSession(
  opts: EnsureComposioSessionOptions,
): Promise<EnsuredComposioSession> {
  const userId = normalizeId(opts.cache.userId) ?? randomUUID();
  const cachedSessionId = normalizeId(opts.cache.sessionId);
  const cachedUrl = normalizeId(opts.cache.mcpUrl);

  if (!opts.forceRefresh && cachedSessionId && cachedUrl) {
    return {
      sessionId: cachedSessionId,
      mcpUrl: cachedUrl,
      toolNames: [],
      userId,
      created: false,
    };
  }

  const create = opts.createSession ?? createComposioSession;
  const session = await create({
    apiKey: opts.apiKey,
    userId,
    ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  await opts.persist({
    userId,
    sessionId: session.sessionId,
    mcpUrl: session.mcpUrl,
  });
  return { ...session, userId, created: true };
}

function normalizeId(value: string | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
