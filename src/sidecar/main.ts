#!/usr/bin/env node
import { MessageRouter } from "./message-router.js";
import { StdioProtocol } from "./stdio-protocol.js";
import { SessionPool } from "./session-pool.js";
import { createAgentEventForwarder } from "./event-forwarder.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import type { PingResult, ShutdownResult } from "./protocol/index.js";
import {
  registerConfigHandlers,
  registerMcpHandlers,
  registerMemoryHandlers,
  registerProviderHandlers,
  registerSessionHandlers,
  registerSkillHandlers,
  registerTaskHandlers,
  registerTelegramHandlers,
  type SidecarHandlerContext,
} from "./handlers/index.js";
import { getConfig } from "../config/index.js";
import { checkLlamaServer } from "../llm/llama-server-health.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";

/**
 * Sidecar entry (v2 protocol). One long-lived `AgentRuntime` hosts N
 * concurrent sessions through a `SessionPool`; every turn funnels through
 * `runtime.turnController.enqueue` so per-session FIFO + cross-session
 * parallelism are inherited from the runtime. All events (approval, logs,
 * metrics, turn/step updates, streaming deltas) travel over NDJSON on
 * stdout. Domain commands are registered by per-domain `register*Handlers`
 * modules; this file only assembles the runtime + transport and owns the
 * process-level (`ping` / `shutdown`) commands. See SIDECAR.md.
 */
export async function bootstrapSidecar(): Promise<{
  protocol: StdioProtocol;
  router: MessageRouter;
  shutdown: () => Promise<void>;
}> {
  const config = getConfig();
  const protocol = new StdioProtocol({
    input: process.stdin,
    output: process.stdout,
    onParseError: (err, rawLine) => {
      protocol.emitEvent("error", {
        message: `failed to parse NDJSON line: ${err.message}`,
        code: "parse_error",
        stack: rawLine,
      });
    },
  });
  const router = new MessageRouter(protocol);
  const pool = new SessionPool();
  const forwardEvent = createAgentEventForwarder(protocol);

  const runtime: AgentRuntime = await createAgentRuntime({
    workingDir: process.cwd(),
    approvalRequired: config.agent.approvalRequired,
    traceDefault: false,
    handlers: {
      onApprovalRequest: (request) => {
        protocol.emitEvent("approval.request", {
          approvalId: request.approvalId,
          sessionId: request.sessionId,
          tool: request.tool,
          reason: request.reason,
          preview: request.preview,
          affectedResources: request.affectedResources,
        });
      },
      onChannelStatus: (status) => {
        protocol.emitEvent("channel.status", {
          channel: status.channel,
          state: status.state,
          ...(status.lastError !== undefined
            ? { lastError: status.lastError }
            : {}),
        });
      },
      onSkillRegistryChange: (entries) => {
        protocol.emitEvent("skill.registry_updated", {
          installed: entries.map((e) => ({ name: e.name, source: e.source })),
        });
      },
      logSinks: [
        (record) => {
          protocol.emitEvent("log", {
            level: record.level,
            message: record.message,
            context: record.context,
          });
        },
      ],
      metricSinks: [
        (sample) => {
          protocol.emitEvent("metric", {
            name: sample.name,
            value: sample.value,
            tags: sample.tags,
          });
        },
      ],
    },
  });

  const ctx: SidecarHandlerContext = {
    router,
    protocol,
    runtime,
    pool,
    forwardEvent,
  };

  const emitLlamaHealth = async (): Promise<void> => {
    const health = await checkLlamaServer();
    if (health.reachable) return;
    const hint =
      config.localModels.mode === "managed"
        ? "run atomic-agent models start"
        : "check localModels.url or ATOMIC_AGENT_LLAMA_URL";
    protocol.emitEvent("llm.unavailable", {
      url: config.localModels.url,
      error: health.error,
      mode: config.localModels.mode,
      hint,
    });
  };

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    pool.abortAll();
    try {
      await runtime.shutdown();
    } catch {
      // already shut down
    }
  };

  router.register<Record<string, never>, PingResult>("ping", () => ({
    ok: true,
    llamaUrl: config.localModels.url,
    stateDir: config.paths.stateDir,
    version: "0.1.0",
    protocolVersion: PROTOCOL_VERSION,
  }));

  registerSessionHandlers(ctx);
  registerTaskHandlers(ctx);
  registerMemoryHandlers(ctx);
  registerMcpHandlers(ctx);
  registerSkillHandlers(ctx);
  registerProviderHandlers(ctx);
  registerTelegramHandlers(ctx);
  registerConfigHandlers(ctx);

  router.register<Record<string, never>, ShutdownResult>(
    "shutdown",
    async () => {
      await shutdown();
      return { ok: true };
    },
  );

  protocol.emitEvent("log", {
    level: "info",
    message: "atomic-agent sidecar booted",
    context: {
      llamaUrl: config.localModels.url,
      stateDir: config.paths.stateDir,
      protocolVersion: PROTOCOL_VERSION,
    },
  });
  void emitLlamaHealth();

  return { protocol, router, shutdown };
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  void bootstrapSidecar();
}
