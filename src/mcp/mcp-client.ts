/**
 * Single-server MCP client.
 *
 * Locked invariant (AGENTS.md §"MCP client"): this is the ONLY file
 * in the runtime that imports `@modelcontextprotocol/sdk`.
 * Everything else operates on the neutral shapes from
 * `mcp-types.ts`. Future replacement of the SDK touches this file
 * and (potentially) `mcp-sampling-handler.ts` only.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CreateMessageRequestSchema,
  type CreateMessageRequest,
  type CreateMessageResult,
} from "@modelcontextprotocol/sdk/types.js";

import { resourceClassFor } from "../agent/tool-resource-class.js";
import { McpConnectError, McpRequestError, scrubErrorMessage } from "./mcp-errors.js";
import {
  qualifyMcpToolName,
  splitMcpToolName,
} from "./mcp-resource-class.js";
import {
  MCP_TOOL_NAME_RE,
  type McpPromptMeta,
  type McpResourceMeta,
  type McpServerCatalog,
  type McpServerConfig,
  type McpToolMeta,
} from "./mcp-types.js";

/**
 * Callback signature for sampling requests forwarded from the server.
 * Implementations live in `mcp-sampling-handler.ts` and route to the
 * agent's `LlmProvider` with `slotId=-1`. Returning the
 * `CreateMessageResult` shape directly keeps this file free of any
 * provider-side imports.
 */
export type McpSamplingHandler = (
  request: CreateMessageRequest["params"],
  signal: AbortSignal,
) => Promise<CreateMessageResult>;

export interface McpClientDeps {
  /**
   * Sampling handler. Optional — when omitted, the client does not
   * advertise the `sampling` capability and any incoming
   * `sampling/createMessage` request fails at the protocol layer.
   */
  samplingHandler?: McpSamplingHandler;
  /**
   * Wall-clock for connect deadlines / debounce timers. Override in
   * tests; production uses `() => Date.now()`.
   */
  now?: () => number;
}

/** Defaults — agent identity advertised to servers in `initialize`. */
const CLIENT_NAME = "atomic-agent";
const CLIENT_VERSION = "0.1.0";
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;

/**
 * Thin wrapper around `@modelcontextprotocol/sdk`'s `Client`. One
 * instance per configured `McpServerConfig`. Lifecycle:
 *
 *   1. `connect()` — builds the transport, calls `client.connect`,
 *      installs the optional sampling handler, refreshes the
 *      catalog. Throws `McpConnectError` on failure.
 *   2. `listTools()` / `listResources()` / `listPrompts()` — return
 *      the catalog refreshed by the last `refreshCatalog` call.
 *   3. `callTool()` / `readResource()` / `getPrompt()` — RPC entry
 *      points. Throw `McpRequestError` on `isError: true` or
 *      transport failure.
 *   4. `close()` — closes the transport and clears the catalog.
 *
 * The instance is reusable across reconnects: `close()` then
 * `connect()` is supported. Concurrent `connect()` calls reject the
 * second with a `McpConnectError`.
 */
export class McpClient {
  private readonly config: McpServerConfig;
  private readonly deps: McpClientDeps;
  private client: Client | null = null;
  private connecting = false;
  private catalog: McpServerCatalog = {
    server: "",
    tools: [],
    resources: [],
    prompts: [],
  };

  constructor(config: McpServerConfig, deps: McpClientDeps = {}) {
    this.config = config;
    this.deps = deps;
    this.catalog = { ...this.catalog, server: config.name };
  }

  get name(): string {
    return this.config.name;
  }

  get isConnected(): boolean {
    return this.client !== null;
  }

  /**
   * Open the transport, run the MCP initialize handshake, install
   * the sampling handler (when provided), and refresh the catalog.
   * Throws `McpConnectError` with a scrubbed message on every
   * failure path so callers do not see SDK-internal stack traces.
   */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.client) return;
    if (this.connecting) {
      throw new McpConnectError(
        this.config.name,
        "connect() already in flight",
      );
    }
    this.connecting = true;
    try {
      const transport = this.buildTransport();
      const client = new Client(
        { name: CLIENT_NAME, version: CLIENT_VERSION },
        {
          capabilities: this.deps.samplingHandler
            ? { sampling: {} }
            : {},
        },
      );

      if (this.deps.samplingHandler) {
        this.installSamplingHandler(client);
      }

      await withTimeout(
        client.connect(transport),
        DEFAULT_CONNECT_TIMEOUT_MS,
        signal,
        () =>
          new McpConnectError(
            this.config.name,
            `connect timeout after ${DEFAULT_CONNECT_TIMEOUT_MS}ms`,
          ),
      ).catch((err) => {
        // Best-effort cleanup; the transport may be half-constructed.
        // Swallow secondary errors so the original cause propagates.
        client.close().catch(() => {});
        throw err instanceof McpConnectError
          ? err
          : new McpConnectError(this.config.name, scrubErrorMessage(err));
      });

      this.client = client;
      await this.refreshCatalog();
    } catch (err) {
      throw err instanceof McpConnectError
        ? err
        : new McpConnectError(this.config.name, scrubErrorMessage(err));
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Discover the server's tools / resources / prompts. Capability
   * misses (e.g. server does not implement resources) are recorded
   * as empty arrays — they never throw.
   */
  async refreshCatalog(): Promise<McpServerCatalog> {
    const client = this.requireClient();
    const caps = client.getServerCapabilities() ?? {};

    const toolsRes = caps.tools
      ? await safeResult(client.listTools({}))
      : null;
    const resourcesRes = caps.resources
      ? await safeResult(client.listResources({}))
      : null;
    const promptsRes = caps.prompts
      ? await safeResult(client.listPrompts({}))
      : null;
    const tools = toolsRes?.tools ?? [];
    const resources = resourcesRes?.resources ?? [];
    const prompts = promptsRes?.prompts ?? [];

    const validTools: McpToolMeta[] = [];
    for (const t of tools as Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
      annotations?: Record<string, unknown>;
    }>) {
      if (!MCP_TOOL_NAME_RE.test(t.name)) continue;
      const qualifiedName = qualifyMcpToolName(this.config.name, t.name);
      // Sanity: the qualified name must round-trip through
      // splitMcpToolName cleanly. If not, drop — this is the same
      // fail-closed posture as `MCP_TOOL_NAME_RE`.
      if (!splitMcpToolName(qualifiedName)) continue;
      validTools.push({
        rawName: t.name,
        qualifiedName,
        server: this.config.name,
        description: typeof t.description === "string" ? t.description : "",
        inputSchema:
          t.inputSchema && typeof t.inputSchema === "object"
            ? (t.inputSchema as Record<string, unknown>)
            : null,
        annotations: t.annotations,
        // Filled by the resolver at lookup time; we still stamp the
        // current best guess here so external consumers (TUI, logs)
        // can render the class without re-running the resolver.
        resourceClass: resourceClassFor(qualifiedName),
      });
    }

    const validResources: McpResourceMeta[] = (resources as Array<{
      uri: string;
      name?: string;
      description?: string;
      mimeType?: string;
    }>).map((r) => ({
      server: this.config.name,
      uri: r.uri,
      ...(r.name ? { name: r.name } : {}),
      ...(r.description ? { description: r.description } : {}),
      ...(r.mimeType ? { mimeType: r.mimeType } : {}),
    }));

    const validPrompts: McpPromptMeta[] = (prompts as Array<{
      name: string;
      description?: string;
      arguments?: Array<{ name: string; description?: string; required?: boolean }>;
    }>).map((p) => ({
      server: this.config.name,
      name: p.name,
      ...(p.description ? { description: p.description } : {}),
      ...(p.arguments ? { arguments: p.arguments } : {}),
    }));

    this.catalog = {
      server: this.config.name,
      tools: validTools,
      resources: validResources,
      prompts: validPrompts,
    };
    return this.catalog;
  }

  /** Current discovered catalog. Returns the empty shape when not connected. */
  getCatalog(): McpServerCatalog {
    return this.catalog;
  }

  /**
   * Invoke a tool by its **raw** name. Returns the SDK response as
   * an opaque record — the adapter is responsible for projecting it
   * into a `CompressedToolResult`. Throws `McpRequestError` on
   * `isError: true` or RPC failure.
   */
  async callTool(
    rawName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs = DEFAULT_TOOL_CALL_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const client = this.requireClient();
    try {
      const res = await withTimeout(
        client.callTool({ name: rawName, arguments: args }),
        timeoutMs,
        signal,
        () =>
          new McpRequestError(
            this.config.name,
            `tools/call:${rawName}`,
            `tool call timeout after ${timeoutMs}ms`,
          ),
      );
      const isError = (res as { isError?: boolean }).isError === true;
      if (isError) {
        throw new McpRequestError(
          this.config.name,
          `tools/call:${rawName}`,
          extractFirstTextContent(res) ?? "tool returned isError=true",
        );
      }
      return res as Record<string, unknown>;
    } catch (err) {
      if (err instanceof McpRequestError) throw err;
      throw new McpRequestError(
        this.config.name,
        `tools/call:${rawName}`,
        scrubErrorMessage(err),
      );
    }
  }

  async readResource(
    uri: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const client = this.requireClient();
    try {
      const res = await withTimeout(
        client.readResource({ uri }),
        DEFAULT_TOOL_CALL_TIMEOUT_MS,
        signal,
        () =>
          new McpRequestError(
            this.config.name,
            `resources/read:${uri}`,
            "read timeout",
          ),
      );
      return res as Record<string, unknown>;
    } catch (err) {
      throw new McpRequestError(
        this.config.name,
        `resources/read:${uri}`,
        scrubErrorMessage(err),
      );
    }
  }

  async getPrompt(
    name: string,
    args: Record<string, string> | undefined,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const client = this.requireClient();
    try {
      const res = await withTimeout(
        client.getPrompt({ name, ...(args ? { arguments: args } : {}) }),
        DEFAULT_TOOL_CALL_TIMEOUT_MS,
        signal,
        () =>
          new McpRequestError(
            this.config.name,
            `prompts/get:${name}`,
            "get timeout",
          ),
      );
      return res as Record<string, unknown>;
    } catch (err) {
      throw new McpRequestError(
        this.config.name,
        `prompts/get:${name}`,
        scrubErrorMessage(err),
      );
    }
  }

  /**
   * Tear down the transport. Idempotent — safe to call when the
   * client was never connected or already closed. Swallows
   * close-time errors (best-effort).
   */
  async close(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.client = null;
    this.catalog = {
      server: this.config.name,
      tools: [],
      resources: [],
      prompts: [],
    };
    try {
      await client.close();
    } catch {
      // best-effort
    }
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new McpConnectError(this.config.name, "client is not connected");
    }
    return this.client;
  }

  private buildTransport():
    | StdioClientTransport
    | StreamableHTTPClientTransport
    | SSEClientTransport {
    const t = this.config.transport;
    if (t.kind === "stdio") {
      // Inherit the agent's `process.env` (already augmented from
      // `<stateDir>/.env` at bootstrap) and overlay per-server keys.
      // See AGENTS.md §"Secrets and process environment" — there is
      // no env filtering today, MCP subprocesses see every var the
      // agent has.
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string") env[k] = v;
      }
      if (this.config.env) Object.assign(env, this.config.env);
      return new StdioClientTransport({
        command: t.command,
        args: t.args ?? [],
        env,
        ...(t.cwd ? { cwd: t.cwd } : {}),
        stderr: "pipe",
      });
    }
    if (t.kind === "streamable_http") {
      return new StreamableHTTPClientTransport(new URL(t.url), {
        requestInit: t.headers ? { headers: { ...t.headers } } : undefined,
      });
    }
    return new SSEClientTransport(new URL(t.url), {
      requestInit: t.headers ? { headers: { ...t.headers } } : undefined,
    });
  }

  private installSamplingHandler(client: Client): void {
    const handler = this.deps.samplingHandler!;
    client.setRequestHandler(
      CreateMessageRequestSchema,
      async (req, extra) => {
        const signal = extra.signal ?? new AbortController().signal;
        return handler(req.params, signal);
      },
    );
  }
}

/** Race a promise against a manual timeout + optional abort signal. */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finalize = (cb: () => void) => {
      if (settled) return;
      settled = true;
      cb();
    };
    const timer = setTimeout(() => {
      finalize(() => reject(onTimeout()));
    }, timeoutMs);
    const onAbort = () => {
      finalize(() => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    promise.then(
      (v) =>
        finalize(() => {
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          resolve(v);
        }),
      (err) =>
        finalize(() => {
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          reject(err);
        }),
    );
  });
}

/**
 * Helper that turns a failed list-* call into `null`. We intentionally
 * swallow listing failures so a misbehaving capability does not
 * poison the other two — the manager surfaces the failure through
 * the status stream instead.
 */
async function safeResult<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

/** Pull the first text content block out of a `tools/call` response. */
function extractFirstTextContent(res: unknown): string | null {
  if (!res || typeof res !== "object") return null;
  const content = (res as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return (block as { text: string }).text;
    }
  }
  return null;
}
