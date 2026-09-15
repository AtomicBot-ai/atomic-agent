import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentLoopEvent } from "../agent/agent-loop.js";
import { resetConfigCache } from "../config/index.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import type { BrowserBackend } from "../tools/browser/browser-backend.js";
import type { TraceEvent } from "../tracing/index.js";
import type { LogRecord } from "../tracing/structured-logger.js";

import { createAgentRuntime } from "./bootstrap.js";

/**
 * The wiring end of the memory sub-call health warning: failing
 * reflections go through the real runner, the real bootstrap hook and
 * the real event fan-out, and the host sees exactly one warning — with
 * tracing on and with it off.
 */

function inertBackend(): BrowserBackend {
  return {
    ensureReady: async () => undefined,
    shutdown: async () => undefined,
  } as unknown as BrowserBackend;
}

function completion(content: string, slotId = 0): CompletionResult {
  return {
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 1, predictedMs: 1, promptTokens: 10, predictedTokens: 5 },
    cacheHitTokens: 0,
    slotId,
    modelId: "mock",
  };
}

describe("memory sub-call health warning through bootstrap", () => {
  let stateDir: string;
  let workingDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-runtime-memhealth-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-cwd-memhealth-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
  });

  it.each([{ traced: true }, { traced: false }])(
    "four failing reflections produce exactly one warning, at the third (traced: $traced)",
    async ({ traced }) => {
      let reflectionCalls = 0;
      const warnings: { event: AgentLoopEvent; sessionId?: string }[] = [];
      const logs: LogRecord[] = [];
      const traceRows: TraceEvent[] = [];
      const runtime = await createAgentRuntime({
        workingDir,
        approvalLevel: 5,
        traceDefault: traced,
        handlers: {
          onAgentEvent: (event, sessionId) => {
            if (
              event.type === "memory_health_warning" &&
              event.kind === "reflection"
            ) {
              warnings.push({ event, ...(sessionId ? { sessionId } : {}) });
            }
          },
          logSinks: [(record) => logs.push(record)],
          traceSinks: [(row) => traceRows.push(row)],
        },
        overrides: {
          browserBackend: inertBackend(),
          skipLlamaHealthCheck: true,
          llamaComplete: async (params) => {
            if (params.sessionId.startsWith("reflection:")) {
              reflectionCalls += 1;
              throw new Error("provider refused the response_format schema");
            }
            // Other sub-calls (rewriter, link-gen) pin slot -1.
            if (params.slotId === -1) {
              return completion("<rewritten_query>NONE</rewritten_query>\n", -1);
            }
            return completion(
              JSON.stringify({ tool: "reply", args: { text: "noted" } }),
            );
          },
        },
      });
      const failures = (): number =>
        logs.filter((r) => r.message === "reflection.failed").length;
      try {
        let session = runtime.createSession();
        for (let turn = 1; turn <= 4; turn += 1) {
          const result = await runtime.runTurn(session, `note number ${turn}`, {
            maxSteps: 3,
          });
          expect(result.reason).toBe("reply");
          session = result.session;
          // Reflection settles after the reply. Waiting for it keeps the
          // next turn from aborting it — `aborted` is neutral and would
          // hide the streak rather than fake one.
          await vi.waitFor(() => expect(failures()).toBe(turn), {
            timeout: 5_000,
          });
          expect(warnings).toHaveLength(turn >= 3 ? 1 : 0);
        }
        expect(reflectionCalls).toBe(4);
        expect(warnings[0]?.sessionId).toBe(session.id);
        expect(warnings[0]?.event).toMatchObject({
          type: "memory_health_warning",
          kind: "reflection",
          outcome: "failed",
          consecutive: 3,
          setting: "memory.reflection.enabled",
          reason: "provider refused the response_format schema",
        });
        // Scoped to reflection: the mocked rewriter reply does not parse,
        // so from turn 2 the rewriter builds a streak — and warns — of its own.
        const warnLogs = logs.filter(
          (r) =>
            r.message === "memory.health.warning" &&
            r.context?.kind === "reflection",
        );
        expect(
          warnLogs.map((r) => [r.level, r.context?.outcome, r.context?.setting]),
        ).toEqual([["warn", "failed", "memory.reflection.enabled"]]);
        const sessionRows = traceRows.filter((r) => r.sessionId === session.id);
        if (traced) {
          // Cause before effect: the trace shows the third failed reflection
          // before the warning it completed, and one warning row only.
          expect(
            sessionRows
              .filter(
                (r) =>
                  r.type === "reflection" ||
                  (r.type === "memory_health_warning" &&
                    r.kind === "reflection"),
              )
              .map((r) => r.type),
          ).toEqual([
            "reflection",
            "reflection",
            "reflection",
            "memory_health_warning",
            "reflection",
          ]);
        } else {
          // No recorder for the session, and the warning arrived anyway.
          expect(sessionRows).toEqual([]);
        }
      } finally {
        await runtime.shutdown();
      }
    },
    60_000,
  );
});
