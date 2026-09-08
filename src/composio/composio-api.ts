/**
 * Minimal Composio REST client — the only file that talks to
 * `backend.composio.dev` over HTTP.
 *
 * atomic-agent deliberately does **not** depend on `@composio/core`.
 * The whole integration needs exactly one call (create a tool-router
 * session), and the SDK would drag a transitive dependency tree into
 * a project that ships a single-file SEA binary. Everything past this
 * module speaks the neutral shapes declared here.
 *
 * The session endpoint returns a hosted MCP URL; from that point on
 * the existing MCP client in `src/mcp/` does all the work — see
 * `buildComposioServerConfig`.
 */

/** Public Composio API root. Overridable per call so tests never go out. */
export const COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3.1";

/** Header Composio authenticates with. Not `Authorization: Bearer`. */
export const COMPOSIO_API_KEY_HEADER = "x-api-key";

/**
 * A created tool-router session: a durable, user-scoped handle whose
 * `mcpUrl` speaks Streamable HTTP MCP.
 */
export interface ComposioSession {
  /** Composio's session handle, `trs_…`. Cached in config for reuse. */
  sessionId: string;
  /** Streamable-HTTP MCP endpoint for this session. */
  mcpUrl: string;
  /** Meta-tool names the session exposes (4 with the workbench off). */
  toolNames: readonly string[];
  /**
   * Composio's own guidance on driving the meta-tools, returned under
   * `experimental.assistive_prompt`. Absent on older API revisions —
   * `src/prompt/` falls back to its own copy when this is undefined.
   */
  assistivePrompt?: string;
}

export class ComposioApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ComposioApiError";
    this.status = status;
  }
}

export interface CreateSessionOptions {
  apiKey: string;
  /** Stable per-install id. Scopes connected accounts; never an email. */
  userId: string;
  baseUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Create a tool-router session and return its MCP endpoint.
 *
 * The workbench is disabled explicitly: Composio would otherwise
 * expose `COMPOSIO_REMOTE_WORKBENCH` / `COMPOSIO_REMOTE_BASH_TOOL`,
 * a remote sandbox that duplicates `os.shell.run` and would quietly
 * route the operator's shell work through a third party.
 */
export async function createComposioSession(
  opts: CreateSessionOptions,
): Promise<ComposioSession> {
  const base = opts.baseUrl ?? COMPOSIO_API_BASE;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  let res: Response;
  try {
    res = await fetch(`${base}/tool_router/session`, {
      method: "POST",
      headers: {
        [COMPOSIO_API_KEY_HEADER]: opts.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        user_id: opts.userId,
        workbench: { enable: false },
      }),
      signal: opts.signal
        ? AbortSignal.any([opts.signal, timeout])
        : timeout,
    });
  } catch (err) {
    // A caller-side cancel is not a Composio outage — let it through
    // untranslated so the pane that cancelled can tell them apart.
    if (opts.signal?.aborted) throw err;
    throw new ComposioApiError(
      `Could not reach Composio: ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new ComposioApiError(
      `Composio rejected the API key (HTTP ${res.status}). Check the key in the Integrations tab.`,
      res.status,
    );
  }
  if (!res.ok) {
    throw new ComposioApiError(
      `Composio returned HTTP ${res.status} ${res.statusText}.`,
      res.status,
    );
  }
  return parseSessionResponse(await res.json());
}

/** Narrow the untyped JSON body into `ComposioSession`. */
export function parseSessionResponse(body: unknown): ComposioSession {
  if (typeof body !== "object" || body === null) {
    throw new ComposioApiError("Composio returned a non-object session body.", 0);
  }
  const obj = body as Record<string, unknown>;
  const sessionId = obj.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new ComposioApiError("Composio session response carried no session_id.", 0);
  }
  const mcp = obj.mcp as Record<string, unknown> | undefined;
  const mcpUrl = mcp?.url;
  if (typeof mcpUrl !== "string" || mcpUrl.length === 0) {
    throw new ComposioApiError("Composio session response carried no mcp.url.", 0);
  }
  const rawTools = obj.tool_router_tools;
  const toolNames = Array.isArray(rawTools)
    ? rawTools.filter((t): t is string => typeof t === "string")
    : [];
  const experimental = obj.experimental as Record<string, unknown> | undefined;
  const assistivePrompt = experimental?.assistive_prompt;
  return {
    sessionId,
    mcpUrl,
    toolNames,
    ...(typeof assistivePrompt === "string" && assistivePrompt.length > 0
      ? { assistivePrompt }
      : {}),
  };
}
