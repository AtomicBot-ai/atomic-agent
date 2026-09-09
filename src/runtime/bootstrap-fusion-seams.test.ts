import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime } from "./bootstrap.js";
import { resetConfigCache } from "../config/index.js";
import { readSessionLlmStamp } from "../session/session-llm.js";
import { isFusionWorkerSessionId } from "../session/fusion-worker-session.js";
import type { BrowserBackend } from "../tools/browser/browser-backend.js";
import type { TraceEvent } from "../tracing/trace/trace-event.js";

const captureMessageSent = vi.fn();
vi.mock("../analytics/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../analytics/index.js")>();
  return {
    ...actual,
    captureMessageSent: (...args: unknown[]) => captureMessageSent(...args),
  };
});

/**
 * Runtime-level contract for fusion worker turns: a pin the registry does
 * not know rejects before anything runs; an ephemeral worker session is
 * never saved, never traced, and never counted as a message sent.
 */
describe("createAgentRuntime fusion seams", () => {
  let stateDir: string;
  let workingDir: string;
  // The browser is never touched by these turns; only `shutdown` runs.
  const backend = {
    ensureReady: async () => {},
    shutdown: async () => {},
  } as unknown as BrowserBackend;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-runtime-fusion-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-cwd-fusion-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
    captureMessageSent.mockClear();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
  });

  const replyCompletion = async () => ({
    content: JSON.stringify({ tool: "reply", args: { text: "worker done" } }),
    timing: { promptTokens: 10, predictedTokens: 5 },
    slotId: 0,
    cacheReused: false,
  });

  it("rejects a providerId the registry does not know, before the turn is queued", async () => {
    let completions = 0;
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: {
        browserBackend: backend,
        skipLlamaHealthCheck: true,
        llamaComplete: async () => {
          completions += 1;
          return replyCompletion();
        },
      },
    });
    try {
      const session = runtime.createSession();
      await expect(
        runtime.runTurn(session, "hi", { providerId: "no-such-provider" }),
      ).rejects.toThrow(/no-such-provider/);
      await expect(
        runtime.executeTurn(session, "hi", { providerId: "no-such-provider" }),
      ).rejects.toThrow(/not configured/);
      expect(completions).toBe(0);
      expect(runtime.turnController.isBusy(session.id)).toBe(false);
      // The configured local provider is a valid pin.
      const result = await runtime.runTurn(session, "hi", {
        providerId: "local-llama",
        maxSteps: 3,
      });
      expect(result.reason).toBe("reply");
      // At least the turn's own completion (the default reflection
      // runner may add one more through the same override).
      expect(completions).toBeGreaterThanOrEqual(1);
    } finally {
      await runtime.shutdown();
    }
  });

  it("an ephemeral worker turn is never saved, traced, or counted as message_sent", async () => {
    const traced: TraceEvent[] = [];
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      traceDefault: true,
      handlers: { traceSinks: [(event) => traced.push(event)] },
      overrides: {
        browserBackend: backend,
        skipLlamaHealthCheck: true,
        llamaComplete: replyCompletion,
      },
    });
    try {
      const parent = runtime.createSession();
      const worker = runtime.createEphemeralSession({
        parentSessionId: parent.id,
        taskId: "t-1",
      });
      expect(isFusionWorkerSessionId(worker.id)).toBe(true);
      expect(runtime.sessionStore.load(worker.id)).toBeNull();

      const result = await runtime.runTurn(worker, "summarise the module", {
        origin: "fusion",
        providerId: "local-llama",
        maxSteps: 3,
      });
      expect(result.reason).toBe("reply");
      expect(result.session.turns.at(-1)).toMatchObject({
        kind: "assistant_reply",
        text: "worker done",
      });

      // Never persisted: no row, no llm stamp, no trace file, no
      // `session_started` for the worker id.
      expect(runtime.sessionStore.load(worker.id)).toBeNull();
      expect(readSessionLlmStamp(result.session.metadata)).toBeNull();
      expect(existsSync(join(stateDir, "traces", `${worker.id}.ndjson`))).toBe(false);
      expect(
        traced.some(
          (e) => e.type === "session_started" && e.sessionId === worker.id,
        ),
      ).toBe(false);
      // Not a person sending a message.
      expect(captureMessageSent).not.toHaveBeenCalled();

      // Control: the same runtime still counts and saves a real turn.
      const real = await runtime.runTurn(parent, "hello", { maxSteps: 3 });
      expect(real.reason).toBe("reply");
      expect(runtime.sessionStore.load(parent.id)).not.toBeNull();
      expect(captureMessageSent).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.shutdown();
    }
  });
});
