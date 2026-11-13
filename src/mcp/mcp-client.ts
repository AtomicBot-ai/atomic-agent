/**
 * Single-server MCP client.
 *
 * Locked invariant (docs/client.md): this is the ONLY file
 * in the runtime that imports `@modelcontextprotocol/sdk`.
 * Everything else operates on the neutral shapes from
 * `mcp-types.ts`. Future replacement of the SDK touches this file
 * and (potentially) `mcp-sampling-handler.ts` only.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  type ClientCapabilities,
  type CreateMessageRequest,
  type CreateMessageResult,
} from "@modelcontextprotocol/sdk/types.js";

import { resourceClassFor } from "../agent/tool-resource-class.js";
import {
  McpConnectError,
  McpRequestError,
  scrubErrorMessage,
} from "./mcp-errors.js";
import {
  attachStderrTail,
  formatStderrTail,
  type StderrTail,
} from "./mcp-stderr-tail.js";
import type { McpElicitationHandler } from "./mcp-elicitation-handler.js";
import { qualifyMcpToolName, splitMcpToolName } from "./mcp-resource-class.js";
import { buildMcpStdioEnv } from "./mcp-stdio-env.js";
import {
  MCP_TOOL_NAME_RE,
  type McpPromptMeta,
  type McpResourceMeta,
  type McpServerCatalog,
  type McpServerConfig,
  type McpToolMeta,
} from "./mcp-types.js";
import { isMcpToolEnabled } from "./mcp-tool-filter.js";

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
   * Elicitation handler (`mcp-elicitation-handler.ts`). Optional: only
   * when a way to ask a person is wired does the client advertise
   * `elicitation` (form mode only); without it a server sees no such
   * capability and must not send `elicitation/create`.
   */
  elicitationHandler?: McpElicitationHandler;
  /**
   * Test seam: build the transport instead of deriving it from
   * `config.transport`. Production never sets it.
   */
  transportFactory?: (config: McpServerConfig) => Transport;
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
/** Grace for a dying child's stderr to arrive after the transport closes. */
const STDERR_SETTLE_MS = 250;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;
/**
 * Timeout handed to the SDK for our own requests. Our `RequestDeadline`
 * is the real one (it can be held during an elicitation); the SDK's
 * fixed 60 s default would otherwise fail a call whose server is still
 * waiting on the person. This is the largest delay `setTimeout` takes.
 */
const SDK_REQUEST_TIMEOUT_MS = 2_147_483_647;

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
  /** Why the last `close()` happened, told to a call it cut short. */
  private closeReason: string | null = null;
  /** `elicitation/create` requests from this server still waiting on a person. */
  private pendingElicitations = 0;
  /** Deadlines of this client's in-flight requests; held while an elicitation is pending. */
  private readonly deadlines = new Set<RequestDeadline>();
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
    this.closeReason = null;
    if (this.connecting) {
      throw new McpConnectError(
        this.config.name,
        "connect() already in flight",
      );
    }
    this.connecting = true;
    let stderrTail: StderrTail = { read: () => "", settle: async () => {} };
    try {
      const transport =
        this.deps.transportFactory?.(this.config) ?? this.buildTransport();
      // Attached before `client.connect()` starts the child: the SDK hands
      // out a PassThrough up front precisely so early output is not lost.
      stderrTail = attachStderrTail(
        transport instanceof StdioClientTransport ? transport.stderr : null,
      );
      const client = new Client(
        { name: CLIENT_NAME, version: CLIENT_VERSION },
        { capabilities: clientCapabilities(this.deps) },
      );

      if (this.deps.samplingHandler) {
        this.installSamplingHandler(client);
      }
      if (this.deps.elicitationHandler) {
        this.installElicitationHandler(client);
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
      ).catch(async (err) => {
        // Best-effort cleanup; the transport may be half-constructed.
        // Swallow secondary errors so the original cause propagates.
        client.close().catch(() => {});
        throw await this.connectError(err, stderrTail);
      });

      this.client = client;
      await this.refreshCatalog();
    } catch (err) {
      throw err instanceof McpConnectError
        ? err
        : await this.connectError(err, stderrTail);
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Wrap a connect failure, appending whatever the server printed on
   * stderr. `Connection closed` alone never says *why* a stdio server
   * refused to start; its last stderr lines usually do.
   */
  private async connectError(
    err: unknown,
    stderrTail: StderrTail,
  ): Promise<McpConnectError> {
    const base =
      err instanceof McpConnectError ? err.message : scrubErrorMessage(err);
    await stderrTail.settle(STDERR_SETTLE_MS);
    const tail = formatStderrTail(stderrTail.read());
    return new McpConnectError(
      this.config.name,
      tail ? `${base} · server stderr: ${tail}` : base,
    );
  }

  /**
   * Discover the server's tools / resources / prompts. Capability
   * misses (e.g. server does not implement resources) are recorded
   * as empty arrays — they never throw.
   */
  async refreshCatalog(): Promise<McpServerCatalog> {
    const client = this.requireClient();
    const caps = client.getServerCapabilities() ?? {};

    const toolsRes = caps.tools ? await safeResult(client.listTools({})) : null;
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
      // Turned off by the operator (`enabledTools` / `disabledTools`).
      if (!isMcpToolEnabled(this.config, t.name)) continue;
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

    const validResources: McpResourceMeta[] = (
      resources as Array<{
        uri: string;
        name?: string;
        description?: string;
        mimeType?: string;
      }>
    ).map((r) => ({
      server: this.config.name,
      uri: r.uri,
      ...(r.name ? { name: r.name } : {}),
      ...(r.description ? { description: r.description } : {}),
      ...(r.mimeType ? { mimeType: r.mimeType } : {}),
    }));

    const validPrompts: McpPromptMeta[] = (
      prompts as Array<{
        name: string;
        description?: string;
        arguments?: Array<{
          name: string;
          description?: string;
          required?: boolean;
        }>;
      }>
    ).map((p) => ({
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
      const res = await this.request(
        (options) =>
          client.callTool({ name: rawName, arguments: args }, undefined, options),
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
      // `close(reason)` cut this call short (a plugin's code was
      // stopped): say why instead of the SDK's bare "Connection closed".
      if (this.client !== client && this.closeReason) {
        throw new McpRequestError(
          this.config.name,
          `tools/call:${rawName}`,
          this.closeReason,
        );
      }
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
      const res = await this.request(
        (options) => client.readResource({ uri }, options),
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
      const res = await this.request(
        (options) =>
          client.getPrompt({ name, ...(args ? { arguments: args } : {}) }, options),
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
   * close-time errors (best-effort). `reason` becomes the error of a
   * tool call still waiting on this server.
   */
  async close(reason?: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.client = null;
    this.closeReason = reason ?? null;
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
    StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport {
    const t = this.config.transport;
    if (t.kind === "stdio") {
      // Only service variables (PATH, HOME, SystemRoot, ...) from the
      // agent's environment, plus the server's own configured `env`.
      // Provider keys loaded from `<stateDir>/.env` stay with the agent.
      // See `buildMcpStdioEnv` and docs/client.md.
      const env = buildMcpStdioEnv(this.config.env);
      // On Windows a bare shim name like `npx` / `npm` is `npx.cmd`, which a
      // no-shell `spawn` cannot resolve (ENOENT). Route bare commands through
      // `cmd.exe /c` so PATHEXT resolution kicks in; absolute paths and
      // commands with an explicit extension are spawned directly.
      const resolved = resolveStdioCommand(t.command, t.args ?? []);
      return new StdioClientTransport({
        command: resolved.command,
        args: resolved.args,
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
    client.setRequestHandler(CreateMessageRequestSchema, async (req, extra) => {
      const signal = extra.signal ?? new AbortController().signal;
      return handler(req.params, signal);
    });
  }

  private installElicitationHandler(client: Client): void {
    const handler = this.deps.elicitationHandler!;
    client.setRequestHandler(ElicitRequestSchema, async (req, extra) => {
      // The SDK aborts `extra.signal` when the server cancels this
      // request or the connection closes, so even an open-ended wait
      // on a person ends with the server.
      const signal = extra.signal ?? new AbortController().signal;
      this.holdDeadlines();
      try {
        return await handler(req.params, signal);
      } finally {
        this.releaseDeadlines();
      }
    });
  }

  /**
   * While the server waits on the person, the call that is waiting on
   * the server must not time out. Elicitations are not tied to a
   * specific call here, so every in-flight request of this client is
   * held; the person answering is progress for all of them.
   */
  private holdDeadlines(): void {
    this.pendingElicitations += 1;
    if (this.pendingElicitations > 1) return;
    for (const d of this.deadlines) d.pause();
  }

  /** Last pending elicitation settled: every held request gets a fresh full window. */
  private releaseDeadlines(): void {
    this.pendingElicitations -= 1;
    if (this.pendingElicitations > 0) return;
    for (const d of this.deadlines) d.start();
  }

  /**
   * Send one SDK request under our own deadline and the caller's
   * signal. The deadline is held while an elicitation from this server
   * is pending (see `holdDeadlines`). On our timeout or the caller's
   * abort the SDK request is aborted too, so it tells the server
   * (`notifications/cancelled`) and drops its response handler.
   */
  private request<T>(
    send: (options: { signal: AbortSignal; timeout: number }) => Promise<T>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onTimeout: () => Error,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const sdkAbort = new AbortController();
      let settled = false;
      const finalize = (cb: () => void) => {
        if (settled) return;
        settled = true;
        deadline.clear();
        this.deadlines.delete(deadline);
        if (signal) signal.removeEventListener("abort", onAbort);
        cb();
      };
      const deadline = new RequestDeadline(timeoutMs, () => {
        const err = onTimeout();
        finalize(() => reject(err));
        sdkAbort.abort(err);
      });
      const onAbort = () => {
        finalize(() => reject(new Error("aborted")));
        sdkAbort.abort();
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.deadlines.add(deadline);
      if (this.pendingElicitations === 0) deadline.start();
      let sent: Promise<T>;
      try {
        sent = send({ signal: sdkAbort.signal, timeout: SDK_REQUEST_TIMEOUT_MS });
      } catch (err) {
        finalize(() => reject(err));
        return;
      }
      sent.then(
        (v) => finalize(() => resolve(v)),
        (err) => finalize(() => reject(err)),
      );
    });
  }
}

/**
 * A request deadline that can be held. `start()` (re)starts a full
 * window, `pause()` stops the clock, `clear()` ends it for good.
 */
class RequestDeadline {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private done = false;

  constructor(
    private readonly ms: number,
    private readonly onExpire: () => void,
  ) {}

  start(): void {
    if (this.done) return;
    this.pause();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.done = true;
      this.onExpire();
    }, this.ms);
  }

  pause(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  clear(): void {
    this.done = true;
    this.pause();
  }
}

/**
 * Capabilities advertised in `initialize`. Each one only when its
 * handler is wired: `elicitation: {}` means form mode only.
 */
export function clientCapabilities(
  deps: Pick<McpClientDeps, "samplingHandler" | "elicitationHandler">,
): ClientCapabilities {
  return {
    ...(deps.samplingHandler ? { sampling: {} } : {}),
    ...(deps.elicitationHandler ? { elicitation: {} } : {}),
  };
}

/**
 * Resolve a stdio transport command for the current platform. On Windows a
 * bare command name (`npx`, `npm`, `uvx`) is a `.cmd` shim that a no-shell
 * `spawn` cannot find; route it through `cmd.exe /c` so PATHEXT resolution
 * applies. Absolute paths and commands with an explicit extension (`.exe`,
 * `.cmd`) are passed through unchanged. POSIX is always a no-op.
 */
export function resolveStdioCommand(
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (process.platform !== "win32") {
    return { command, args: [...args] };
  }
  const hasExtension = /\.[a-z0-9]+$/i.test(command);
  const hasSeparator = command.includes("\\") || command.includes("/");
  if (hasExtension || hasSeparator) {
    return { command, args: [...args] };
  }
  const comSpec =
    typeof process.env.ComSpec === "string" && process.env.ComSpec.length > 0
      ? process.env.ComSpec
      : "cmd.exe";
  return { command: comSpec, args: ["/d", "/s", "/c", command, ...args] };
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
