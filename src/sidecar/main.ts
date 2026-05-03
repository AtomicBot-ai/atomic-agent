#!/usr/bin/env node
import { resolve } from "node:path";

import { MessageRouter } from "./message-router.js";
import { StdioProtocol } from "./stdio-protocol.js";
import { getConfig } from "../config/index.js";
import { checkLlamaServer } from "../llm/llama-server-health.js";
import { createAgentRuntime } from "../runtime/bootstrap.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";
import type { AgentLoopEvent } from "../agent/agent-loop.js";
import type {
  ApprovalResponsePayload,
  CancelPayload,
  GetSessionPayload,
  SendMessagePayload,
  SkillInstallPayload,
  SkillUninstallPayload,
  StartSessionPayload,
} from "./sidecar-events.js";
import type { SessionState } from "../session/index.js";
import { installSkill, uninstallSkill } from "../skills/index.js";

interface ActiveSession {
  session: SessionState;
  runtime: AgentRuntime;
  controller: AbortController;
  eventSink: (event: AgentLoopEvent) => void;
}

/**
 * Sidecar entry. Each process hosts exactly one active session at a time
 * (start_session builds or replaces it). All events (approval, logs,
 * metrics, step updates) travel over NDJSON on stdout.
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

  let active: ActiveSession | null = null;

  const disposeActive = async (): Promise<void> => {
    if (!active) return;
    active.controller.abort();
    try {
      await active.runtime.shutdown();
    } catch {
      // already shut down
    }
    active = null;
  };

  const forwardAgentEvent = (
    sessionId: string,
  ): ((event: AgentLoopEvent) => void) =>
    (event) => {
      switch (event.type) {
        case "step_started":
          protocol.emitEvent("step_started", {
            sessionId,
            stepIndex: event.stepIndex,
          });
          break;
        case "step_finished":
          protocol.emitEvent("step_finished", {
            sessionId,
            stepIndex: event.stepIndex,
            tokensUsed: 0,
            durationMs: event.durationMs,
          });
          break;
        case "llm_event": {
          const inner = event.event;
          if (inner.type === "tool_call_parsed") {
            protocol.emitEvent("tool_call_started", {
              sessionId,
              stepIndex: -1,
              tool: inner.call.tool,
              args: inner.call.args,
              ...(inner.batchSize > 1
                ? {
                    batchIndex: inner.batchIndex,
                    batchSize: inner.batchSize,
                  }
                : {}),
            });
          } else if (inner.type === "tool_call_executed") {
            protocol.emitEvent("tool_call_result", {
              sessionId,
              stepIndex: -1,
              tool: inner.result.tool,
              status: inner.result.status,
              summary: inner.result.summary,
              truncated: inner.result.truncated,
              ...(inner.batchSize > 1
                ? {
                    batchIndex: inner.batchIndex,
                    batchSize: inner.batchSize,
                  }
                : {}),
            });
          } else if (inner.type === "assistant_reply") {
            protocol.emitEvent("assistant_reply", {
              sessionId,
              text: inner.text,
            });
          } else if (inner.type === "assistant_delta") {
            protocol.emitEvent("assistant_delta", {
              sessionId,
              text: inner.text,
            });
          } else if (inner.type === "reasoning_delta") {
            protocol.emitEvent("reasoning_delta", {
              sessionId,
              stepIndex: inner.stepIndex,
              text: inner.text,
            });
          } else if (inner.type === "step_error") {
            protocol.emitEvent("error", {
              message: inner.error.message,
              code: `step_error:${inner.category}`,
              stack: inner.error.stack,
            });
          }
          break;
        }
        case "user_message":
          protocol.emitEvent("user_message", {
            sessionId,
            text: event.text,
          });
          break;
        case "turn_started":
          protocol.emitEvent("turn_started", {
            sessionId,
            turnIndex: event.turnIndex,
          });
          break;
        case "turn_finished":
          protocol.emitEvent("turn_finished", {
            sessionId,
            turnIndex: event.turnIndex,
            reason: event.reason,
            stepCount: event.stepCount,
            durationMs: event.durationMs,
          });
          break;
        case "loop_completed":
          if (event.reason === "finish" || event.reason === "max_steps") {
            protocol.emitEvent("session_completed", {
              sessionId,
              reason: event.reason,
            });
          }
          break;
        case "loop_failed":
          protocol.emitEvent("session_failed", {
            sessionId,
            error: event.error.message,
            category: event.category,
          });
          break;
      }
    };

  const buildRuntime = async (workingDir: string): Promise<AgentRuntime> => {
    return createAgentRuntime({
      workingDir,
      approvalRequired: config.agent.approvalRequired,
      traceDefault: false,
      handlers: {
        onAgentEvent: (event) => {
          // `active` is mutated after session creation — the indirection
          // lets us bind the sessionId-aware forwarder without rebuilding
          // the runtime for every new session.
          active?.eventSink(event);
        },
        onApprovalRequest: (request) => {
          protocol.emitEvent("approval_request", {
            approvalId: request.approvalId,
            sessionId: request.sessionId,
            tool: request.tool,
            reason: request.reason,
            preview: request.preview,
            affectedResources: request.affectedResources,
          });
        },
        onSkillRegistryChange: (entries) => {
          protocol.emitEvent("skill_registry_updated", {
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
  };

  router.register("ping", () => ({
    ok: true,
    llamaUrl: config.localModels.url,
    stateDir: config.paths.stateDir,
    version: "0.1.0",
  }));

  router.register<StartSessionPayload, { sessionId: string }>(
    "start_session",
    async (request) => {
      await disposeActive();
      const workingDir = resolve(request.payload.workingDir);
      const runtime = await buildRuntime(workingDir);
      const health = await checkLlamaServer();
      if (!health.reachable) {
        const hint =
          config.localModels.mode === "managed"
            ? "run atomic-agent models start"
            : "check localModels.url or ATOMIC_AGENT_LLAMA_URL";
        protocol.emitEvent("llm_unavailable", {
          url: config.localModels.url,
          error: health.error,
          mode: config.localModels.mode,
          hint,
        });
      }
      const session = runtime.createSession({
        ...(request.payload.metadata
          ? { metadata: request.payload.metadata }
          : {}),
      });
      const controller = new AbortController();
      active = {
        runtime,
        session,
        controller,
        eventSink: forwardAgentEvent(session.id),
      };
      protocol.emitEvent("session_started", {
        sessionId: session.id,
        workingDir,
      });
      return { sessionId: session.id };
    },
  );

  router.register<
    SendMessagePayload,
    { reason: string; turnCount: number; stepCount: number }
  >("send_message", async (request) => {
    if (!active || active.session.id !== request.payload.sessionId) {
      throw new Error(
        `no active session with id ${request.payload.sessionId}`,
      );
    }
    const { runtime } = active;
    const sessionId = request.payload.sessionId;
    // Route through the per-session turn controller so two rapid
    // `send_message` requests on the same NDJSON stream serialise
    // FIFO. Re-reading `active.session` inside the run callback is
    // load-bearing: when the second message starts, the first turn
    // has already mutated `active.session`, and the queued body
    // must pick up that updated state instead of the stale value
    // captured at request-handler entry.
    const result = await runtime.turnController.enqueue({
      sessionId,
      origin: "sidecar",
      signal: active.controller.signal,
      run: async () => {
        if (!active || active.session.id !== sessionId) {
          throw new Error(
            `active session changed during queued send_message for ${sessionId}`,
          );
        }
        return runtime.executeTurn(active.session, request.payload.text, {
          maxSteps: request.payload.maxSteps ?? runtime.config.agent.maxSteps,
          signal: active.controller.signal,
        });
      },
    });
    active = { ...active, session: result.session };
    return {
      reason: result.reason,
      turnCount: result.session.turnCount,
      stepCount: result.session.stepCount,
    };
  });

  router.register<ApprovalResponsePayload, { resolved: boolean }>(
    "approval_response",
    (request) => {
      if (!active) return { resolved: false };
      const resolved = active.runtime.approvals.resolve({
        approvalId: request.payload.approvalId,
        approved: request.payload.approved,
        ...(request.payload.reason !== undefined
          ? { reason: request.payload.reason }
          : {}),
      });
      return { resolved };
    },
  );

  router.register<CancelPayload, { cancelled: boolean }>(
    "cancel",
    (request) => {
      if (!active || active.session.id !== request.payload.sessionId) {
        return { cancelled: false };
      }
      active.controller.abort();
      return { cancelled: true };
    },
  );

  router.register<GetSessionPayload, SessionState | null>(
    "get_session",
    (request) => {
      if (active?.session.id === request.payload.sessionId) return active.session;
      // Fall back to sqlite if we have a runtime to ask.
      if (active) return active.runtime.sessionStore.load(request.payload.sessionId);
      return null;
    },
  );

  router.register<SkillInstallPayload, { name: string; installedAt: string }>(
    "skill_install",
    async (request) => {
      if (!active) throw new Error("no active session — call start_session first");
      const result = await installSkill({
        sourceDir: request.payload.sourcePath,
        targetRoot: config.paths.globalSkillsDir,
        ...(request.payload.force !== undefined
          ? { force: request.payload.force }
          : {}),
      });
      await active.runtime.refreshSkills();
      return { name: result.manifest.name, installedAt: result.installedAt };
    },
  );

  router.register<SkillUninstallPayload, { removed: boolean }>(
    "skill_uninstall",
    async (request) => {
      if (!active) throw new Error("no active session — call start_session first");
      const result = await uninstallSkill(
        config.paths.globalSkillsDir,
        request.payload.name,
      );
      await active.runtime.refreshSkills();
      return { removed: result.removed };
    },
  );

  router.register("skill_list", () => {
    if (!active) return { skills: [] };
    return {
      skills: active.runtime.skillRegistry.list().map((r) => ({
        name: r.manifest.name,
        version: r.manifest.version,
        description: r.manifest.description,
        source: r.source,
      })),
    };
  });

  router.register("shutdown", async () => {
    await disposeActive();
    return { ok: true };
  });

  protocol.emitEvent("log", {
    level: "info",
    message: "atomic-agent sidecar booted",
    context: { llamaUrl: config.localModels.url, stateDir: config.paths.stateDir },
  });

  return {
    protocol,
    router,
    shutdown: disposeActive,
  };
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  void bootstrapSidecar();
}
