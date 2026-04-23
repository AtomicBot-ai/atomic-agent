import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../config/index.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import type {
  CompletionResult,
  StreamChunk,
} from "../llm/llama-server-client.js";
import type {
  AriaSnapshot,
  BrowserBackend,
  ClickInput,
  NavigateInput,
  ScrollInput,
  ScrollResult,
  SearchInput,
  TabInfo,
  TabsInput,
  TypeInput,
} from "../tools/browser/browser-backend.js";
import type { ApprovalRequest } from "../approval/approval-gate.js";
import type { AgentLoopEvent } from "../agent/agent-loop.js";
import type { LogSink } from "../telemetry/structured-logger.js";

import { ApprovalBus } from "./approval-bus.js";
import { CompletionRegistry } from "./completion-registry.js";
import { TurnHub } from "./turn-hub.js";
import { createHttpServer, type HttpServerHandle } from "./http-server.js";
import { buildRouteTable } from "./route-table.js";

/**
 * Inert browser backend — the HTTP tests never actually drive a
 * browser, they only need the runtime to initialise without the real
 * Playwright backend trying to spawn Chromium.
 */
export class FakeBrowserBackend implements BrowserBackend {
  async ensureReady(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async hasRef(): Promise<boolean> {
    return false;
  }
  async snapshot(): Promise<AriaSnapshot> {
    return {
      url: "https://example.com/",
      title: "Example",
      digest: "deadbeef",
      refs: [],
      text: "url: https://example.com/\ntitle: Example\n",
    };
  }
  async navigate(input: NavigateInput): Promise<{ url: string; title: string }> {
    return { url: input.url, title: "Example" };
  }
  async click(input: ClickInput): Promise<{ clickedRef: string }> {
    return { clickedRef: input.ref };
  }
  async type(input: TypeInput): Promise<{ typedLength: number }> {
    return { typedLength: input.text.length };
  }
  async search(input: SearchInput): Promise<{ url: string }> {
    return { url: `https://search.example/?q=${input.query}` };
  }
  async tabs(_input: TabsInput): Promise<{ tabs: TabInfo[] }> {
    return { tabs: [] };
  }
  async scroll(_input: ScrollInput): Promise<ScrollResult> {
    return { scrollY: 0, scrollHeight: 0, viewportHeight: 800 };
  }
}

export interface HarnessOptions {
  /** When set, the HTTP server requires this bearer token. */
  apiKey?: string | null;
  /** Replace the llama completion implementation. Default: one `reply` turn. */
  llamaComplete?: (params: {
    prompt: string;
    grammar: string;
    slotId: number;
    sessionId: string;
  }) => Promise<CompletionResult>;
  /**
   * Optional streaming LLM stub. When supplied, the runtime exercises
   * the streaming code path and the unary `llamaComplete` is only used
   * as the non-stream fallback for HTTP endpoints that expect a single
   * JSON response.
   */
  llamaCompleteStream?: (params: {
    prompt: string;
    grammar: string;
    slotId: number;
    sessionId: string;
  }) => AsyncGenerator<StreamChunk, CompletionResult, void>;
  llamaProps?: Record<string, unknown>;
  llamaPropsError?: Error;
  /** Approval required flag (default: false to keep tests deterministic). */
  approvalRequired?: boolean;
  /** Extra inspector for each agent event. */
  onAgentEvent?: (event: AgentLoopEvent) => void;
  /** Extra inspector for each approval request. */
  onApprovalRequest?: (request: ApprovalRequest) => void;
  /** Optional log sinks for runtime diagnostics assertions. */
  logSinks?: LogSink[];
}

export interface Harness {
  runtime: AgentRuntime;
  handle: HttpServerHandle;
  baseUrl: string;
  stateDir: string;
  workingDir: string;
  turnHub: TurnHub;
  approvalBus: ApprovalBus;
  completionRegistry: CompletionRegistry;
  cleanup: () => Promise<void>;
}

/**
 * Spin up a full HTTP surface against a fake runtime. Uses isolated
 * tmp dirs for state + cwd and `port: 0` so the harness never clashes
 * with another running server. Callers must `await harness.cleanup()`
 * in an `afterEach` — otherwise the browser backend leak guard in the
 * bootstrap will keep the vitest worker alive.
 */
export async function startTestHarness(
  options: HarnessOptions = {},
): Promise<Harness> {
  const stateDir = mkdtempSync(join(tmpdir(), "atomic-http-state-"));
  const workingDir = mkdtempSync(join(tmpdir(), "atomic-http-cwd-"));
  mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
  process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
  process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
  resetConfigCache();

  const defaultComplete = async (): Promise<CompletionResult> => ({
    content: JSON.stringify({ tool: "reply", args: { text: "hi back" } }),
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: {
      promptMs: 0,
      predictedMs: 0,
      promptTokens: 5,
      predictedTokens: 3,
    },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: null,
  });

  const turnHub = new TurnHub();
  const approvalBus = new ApprovalBus();
  const completionRegistry = new CompletionRegistry();

  const runtime = await createAgentRuntime({
    workingDir,
    approvalRequired: options.approvalRequired ?? false,
    handlers: {
      logSinks: options.logSinks,
      onAgentEvent: (event) => {
        turnHub.emit(event);
        options.onAgentEvent?.(event);
      },
      onApprovalRequest: (request) => {
        approvalBus.publish(request);
        options.onApprovalRequest?.(request);
      },
    },
    overrides: {
      browserBackend: new FakeBrowserBackend(),
      skipLlamaHealthCheck: true,
      llamaComplete: options.llamaComplete ?? defaultComplete,
      ...(options.llamaProps ? { llamaProps: options.llamaProps } : {}),
      ...(options.llamaPropsError ? { llamaPropsError: options.llamaPropsError } : {}),
      ...(options.llamaCompleteStream
        ? { llamaCompleteStream: options.llamaCompleteStream }
        : {}),
    },
  });

  const handle = await createHttpServer({
    runtime,
    host: "127.0.0.1",
    port: 0,
    apiKey: options.apiKey ?? null,
    routes: buildRouteTable(),
    approvalBus,
    turnHub,
    completionRegistry,
  });

  return {
    runtime,
    handle,
    baseUrl: `http://${handle.host}:${handle.port}`,
    stateDir,
    workingDir,
    turnHub,
    approvalBus,
    completionRegistry,
    cleanup: async () => {
      await handle.close();
      await runtime.shutdown();
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(workingDir, { recursive: true, force: true });
      delete process.env.ATOMIC_AGENT_STATE_DIR;
      delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
      resetConfigCache();
    },
  };
}
