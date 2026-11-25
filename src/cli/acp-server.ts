/**
 * The Agent Client Protocol server behind `atomic-agent acp` (ATO-543):
 * Zed, JetBrains, Neovim and other ACP clients start the agent as a
 * subprocess and drive it over JSON-RPC on stdio. This file holds the
 * protocol state (sessions, turns, cancels, permission round trips);
 * the wire framing is `acp-jsonrpc.ts` and the event mapping is
 * `acp-translator.ts`. The runtime is the same one the TUI, `serve` and
 * the desktop sidecar build, so tools, memory, skills and the approval
 * gate behave as they do there.
 *
 * Supported: `initialize`, `authenticate` (a no-op), `session/new`,
 * `session/prompt`, the `session/cancel` notification, and outgoing
 * `session/update` and `session/request_permission`. Not yet:
 * `session/load`, modes, the client's MCP servers and its file system.
 */

import { isAbsolute } from "node:path";
import type { ApprovalGate, ApprovalRequest } from "../approval/approval-gate.js";
import type { AgentLoopEvent, AgentLoopReason } from "../agent/agent-contract.js";
import type { SessionState } from "../session/index.js";
import {
  JSONRPC_INVALID_PARAMS,
  JSONRPC_METHOD_NOT_FOUND,
  JsonRpcError,
} from "./acp-jsonrpc.js";
import {
  AcpTurnTranslator,
  permissionDecision,
  permissionOptions,
  permissionToolCall,
  promptToText,
  stopReason,
  type AcpStopReason,
} from "./acp-translator.js";

/** ACP major version this server speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/** The id of the one auth method `initialize` lists. */
export const ACP_SETUP_METHOD_ID = "atomic-agent-setup";

/** What the server needs from an agent runtime; `AgentRuntime` fits. */
export interface AcpRuntime {
  readonly approvals: Pick<ApprovalGate, "resolve" | "canGrantAlways" | "denyPendingForSession">;
  readonly sessionStore: { load(id: string): SessionState | null };
  createSession(input?: { metadata?: Record<string, unknown> }): SessionState;
  runTurn(
    session: SessionState,
    userMessage: string,
    options: {
      signal: AbortSignal;
      eventHook: (event: AgentLoopEvent) => void;
      origin: "sidecar";
      interactive: boolean;
    },
  ): Promise<{ session: SessionState; reason: AgentLoopReason }>;
  shutdown(): Promise<void>;
}

export interface AcpRuntimeHandlers {
  onApprovalRequest(request: ApprovalRequest): void;
}

/** The outgoing half of the connection. */
export interface AcpClient {
  notify(method: string, params: unknown): void;
  request(method: string, params: unknown): Promise<unknown>;
}

export interface AcpServerOptions {
  /** One runtime per working folder; called once per distinct `cwd`. */
  createRuntime(workingDir: string, handlers: AcpRuntimeHandlers): Promise<AcpRuntime>;
  version: string;
  /**
   * The command line a client runs in a terminal for the setup method
   * (`atomic-agent acp --setup`), for clients that still read the
   * `_meta["terminal-auth"]` form.
   */
  setupCommand: { command: string; args: string[] };
  log?: (message: string) => void;
}

interface AcpSession {
  id: string;
  workingDir: string;
  runtime: AcpRuntime;
  state: SessionState;
  translator: AcpTurnTranslator;
  /** Controllers of the prompts in flight (queued ones included). */
  controllers: Set<AbortController>;
}

export class AcpServer {
  private client: AcpClient | null = null;
  private readonly runtimes = new Map<string, Promise<AcpRuntime>>();
  private readonly sessions = new Map<string, AcpSession>();

  constructor(private readonly options: AcpServerOptions) {}

  attach(client: AcpClient): void {
    this.client = client;
  }

  async handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.initialize(params);
      case "authenticate":
        return this.authenticate(params);
      case "session/new":
        return this.newSession(params);
      case "session/prompt":
        return this.prompt(params);
      default:
        throw new JsonRpcError(JSONRPC_METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  handleNotification(method: string, params: unknown): void {
    if (method === "session/cancel") {
      const sessionId = isObject(params) && typeof params.sessionId === "string" ? params.sessionId : null;
      if (sessionId !== null) this.cancel(sessionId);
      return;
    }
    // Unknown notifications are ignored, as JSON-RPC allows.
  }

  /** Stop every turn and close the runtimes (the client went away). */
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) this.cancel(session.id);
    this.sessions.clear();
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    for (const pending of runtimes) {
      try {
        await (await pending).shutdown();
      } catch (err) {
        this.options.log?.(`runtime shutdown failed: ${String(err)}`);
      }
    }
  }

  private initialize(params: unknown): Record<string, unknown> {
    if (!isObject(params) || typeof params.protocolVersion !== "number") {
      throw new JsonRpcError(JSONRPC_INVALID_PARAMS, "initialize needs a numeric protocolVersion");
    }
    const { command, args } = this.options.setupCommand;
    return {
      // Only v1 exists; a client asking for another gets ours and decides.
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
      },
      agentInfo: { name: "atomic-agent", title: "Atomic Agent", version: this.options.version },
      // The ACP registry requires one `agent` or `terminal` method. Like
      // the other registry agents that sign in from a terminal, ours runs
      // the agent's own first-run setup (pick a local model or connect a
      // provider); there is no account to log in to.
      authMethods: [
        {
          id: ACP_SETUP_METHOD_ID,
          name: "Set up Atomic Agent",
          description: "Pick a local model or connect a provider in the terminal",
          type: "terminal",
          args: ["--setup"],
          _meta: { "terminal-auth": { label: "Atomic Agent setup", command, args } },
        },
      ],
    };
  }

  private authenticate(params: unknown): Record<string, never> {
    const methodId = isObject(params) ? params.methodId : undefined;
    if (methodId !== ACP_SETUP_METHOD_ID) {
      throw new JsonRpcError(JSONRPC_INVALID_PARAMS, `unknown auth method: ${String(methodId)}`);
    }
    // Setup runs in the terminal; there is nothing to check here.
    return {};
  }

  private async newSession(params: unknown): Promise<{ sessionId: string }> {
    if (!isObject(params) || typeof params.cwd !== "string" || !isAbsolute(params.cwd)) {
      throw new JsonRpcError(JSONRPC_INVALID_PARAMS, "session/new needs an absolute cwd");
    }
    const workingDir = params.cwd;
    if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
      this.options.log?.(
        `ignoring ${params.mcpServers.length} MCP server(s) from the client; configure them in atomic-agent instead`,
      );
    }
    const runtime = await this.runtimeFor(workingDir);
    const state = runtime.createSession({ metadata: { source: "acp" } });
    this.sessions.set(state.id, {
      id: state.id,
      workingDir,
      runtime,
      state,
      translator: new AcpTurnTranslator(),
      controllers: new Set(),
    });
    return { sessionId: state.id };
  }

  private async prompt(params: unknown): Promise<{ stopReason: AcpStopReason }> {
    if (!isObject(params) || typeof params.sessionId !== "string") {
      throw new JsonRpcError(JSONRPC_INVALID_PARAMS, "session/prompt needs a sessionId");
    }
    const session = this.sessions.get(params.sessionId);
    if (session === undefined) {
      throw new JsonRpcError(JSONRPC_INVALID_PARAMS, `unknown session: ${params.sessionId}`);
    }
    const text = promptToText(params.prompt);
    if (text.length === 0) {
      throw new JsonRpcError(JSONRPC_INVALID_PARAMS, "session/prompt needs at least one text block");
    }
    const controller = new AbortController();
    session.controllers.add(controller);
    try {
      const latest = session.runtime.sessionStore.load(session.id) ?? session.state;
      const result = await session.runtime.runTurn(latest, text, {
        signal: controller.signal,
        eventHook: (event) => this.forward(session, event),
        origin: "sidecar",
        // A person reads the editor's chat and answers its permission
        // prompts, as in the desktop app.
        interactive: true,
      });
      session.state = result.session;
      return { stopReason: controller.signal.aborted ? "cancelled" : stopReason(result.reason) };
    } catch (err) {
      // A cancel that surfaced as an abort error is still a cancel.
      if (controller.signal.aborted) return { stopReason: "cancelled" };
      throw err;
    } finally {
      session.controllers.delete(controller);
    }
  }

  private cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    for (const controller of session.controllers) controller.abort();
    session.runtime.approvals.denyPendingForSession(sessionId, "cancelled in the editor");
  }

  private forward(session: AcpSession, event: AgentLoopEvent): void {
    for (const update of session.translator.translate(event)) {
      this.client?.notify("session/update", { sessionId: session.id, update });
    }
  }

  private runtimeFor(workingDir: string): Promise<AcpRuntime> {
    let pending = this.runtimes.get(workingDir);
    if (pending === undefined) {
      pending = this.options.createRuntime(workingDir, {
        onApprovalRequest: (request) => void this.askPermission(workingDir, request),
      });
      // A failed boot must not stick: the next session/new tries again.
      pending.catch(() => this.runtimes.delete(workingDir));
      this.runtimes.set(workingDir, pending);
    }
    return pending;
  }

  /** The ACP session an approval belongs to, or `undefined`. */
  private sessionForApproval(workingDir: string, request: ApprovalRequest): AcpSession | undefined {
    const own = this.sessions.get(request.sessionId);
    if (own !== undefined) return own;
    // A worker session the agent started (fusion, sub-agents) asks under
    // its own id. Route it to the one chat in that folder that is running
    // a prompt; with none or several, nobody can be shown it.
    const busy = [...this.sessions.values()].filter(
      (s) => s.workingDir === workingDir && s.controllers.size > 0,
    );
    return busy.length === 1 ? busy[0] : undefined;
  }

  private async askPermission(workingDir: string, request: ApprovalRequest): Promise<void> {
    const runtime = await this.runtimes.get(workingDir);
    if (runtime === undefined) return;
    const session = this.sessionForApproval(workingDir, request);
    const client = this.client;
    if (session === undefined || client === null) {
      runtime.approvals.resolve({
        approvalId: request.approvalId,
        approved: false,
        automatic: true,
        reason: "no editor chat to show this approval in",
      });
      return;
    }
    const canAlways = runtime.approvals.canGrantAlways(request);
    const toolCallId = session.translator.openCallFor(request.tool) ?? `approval-${request.approvalId}`;
    let outcome: unknown;
    try {
      const response = await client.request("session/request_permission", {
        sessionId: session.id,
        toolCall: permissionToolCall(request, toolCallId),
        options: permissionOptions(request, canAlways),
      });
      outcome = isObject(response) ? response.outcome : undefined;
    } catch (err) {
      this.options.log?.(`permission request failed: ${String(err)}`);
      outcome = undefined;
    }
    // `false` when it was already settled (a cancel denied it first).
    runtime.approvals.resolve(permissionDecision(request, canAlways, outcome));
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
