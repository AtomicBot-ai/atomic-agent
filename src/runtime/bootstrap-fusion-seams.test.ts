import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime } from "./bootstrap.js";
import { resetConfigCache } from "../config/index.js";
import type { LlmStreamParams } from "../agent/step-executor.js";
import { FUSION_GUIDANCE } from "../prompt/fusion-guidance.js";
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
      expect(existsSync(join(stateDir, "traces", `${worker.id}.ndjson`))).toBe(
        false,
      );
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

/**
 * The mode has to be switchable in a running process.
 *
 * An operator who starts on local or cloud and moves into fusion from
 * Manage → LLM got the mode's chrome and nothing else: `fusion.delegate`
 * was registered behind a boot-time `if`, and the descriptor gate that
 * puts the tool and its `### fusion` guidance in the prompt was frozen
 * in the same instant. Fusion then did nothing at all until a restart.
 */
describe("createAgentRuntime fusion gate is live", () => {
  const CLOUD = "cloud-orchestrator";
  const LOCAL = "local-llama";
  let stateDir: string;
  let workingDir: string;
  const backend = {
    ensureReady: async () => {},
    shutdown: async () => {},
  } as unknown as BrowserBackend;

  const writeConfig = (activeTextProvider: string): void => {
    writeFileSync(
      join(stateDir, "config.json"),
      JSON.stringify({
        version: 52,
        llm: {
          activeTextProvider,
          activeEmbeddingProvider: LOCAL,
          toolTransport: "grammar",
          providers: [
            {
              id: CLOUD,
              kind: "openai-compatible",
              baseUrl: "https://example.invalid",
              apiKey: "test-key",
              defaultChatModel: "orchestrator-model",
            },
            { id: LOCAL, kind: "llama-server", url: "http://127.0.0.1:8080" },
          ],
          // Stored fusion throughout: `activeTextProvider` is what
          // decides whether it is effective (§"Run modes"), and it is
          // the switch this test performs.
          runMode: {
            mode: "fusion",
            fusion: { orchestratorProvider: CLOUD, workerProvider: LOCAL },
          },
        },
      }),
      "utf8",
    );
    resetConfigCache();
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-fusion-gate-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-fusion-gate-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    writeConfig(LOCAL);
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
  });

  it("a switch into fusion mid-process reaches the tool AND the next prompt", async () => {
    const prompts: string[] = [];
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: {
        browserBackend: backend,
        skipLlamaHealthCheck: true,
        llamaComplete: async (params: LlmStreamParams) => {
          prompts.push(params.prompt);
          return {
            content: JSON.stringify([{ tool: "reply", args: { text: "ok" } }]),
            timing: { promptTokens: 10, predictedTokens: 5 },
            slotId: 0,
            cacheReused: false,
          };
        },
      },
    });
    try {
      // Booted on the local leg: fusion is stored but not effective.
      // The tool is registered anyway — its own live refusal is the gate
      // — but the model is told nothing about it.
      expect(runtime.toolRegistry.has("fusion.delegate")).toBe(true);
      expect(
        runtime.toolDescriptors.some((d) => d.name === "fusion.delegate"),
      ).toBe(false);

      // The turn's own step prompt — the memory sub-calls and the
      // end-of-turn reflection ride the same completion seam with
      // prompts that carry no tool catalog at all.
      const session = runtime.createSession();
      const turnPrompt = async (text: string): Promise<string> => {
        prompts.length = 0;
        await runtime.runTurn(session, text, { maxSteps: 2 });
        const step = prompts.filter((p) => p.includes("### tools"));
        expect(step.length).toBeGreaterThan(0);
        return step[0]!;
      };

      const before = await turnPrompt("before");
      expect(before).not.toContain("fusion.delegate");
      expect(before).not.toContain(FUSION_GUIDANCE);

      // The operator moves into fusion: config write + active provider,
      // exactly the pair every TUI mode write performs.
      writeConfig(CLOUD);
      await runtime.providerRegistry.setActive(CLOUD);

      expect(
        runtime.toolDescriptors.some((d) => d.name === "fusion.delegate"),
      ).toBe(true);
      const after = await turnPrompt("after");
      expect(after).toContain("fusion.delegate");
      expect(after).toContain(FUSION_GUIDANCE);

      // …and back out again: the descriptor and the guidance leave with
      // the mode, so a cloud-only session is never told it can delegate.
      writeConfig(LOCAL);
      await runtime.providerRegistry.setActive(LOCAL);
      const back = await turnPrompt("and back");
      expect(back).not.toContain("fusion.delegate");
      expect(back).not.toContain(FUSION_GUIDANCE);
    } finally {
      await runtime.shutdown();
    }
  });

  it("keeps one array identity while the gate holds, so the prefix is stable", async () => {
    // The gate is re-read on every access; the list must not be rebuilt
    // on every access. A fresh array per step would churn the stable
    // prefix's inputs for nothing.
    const runtime = await createAgentRuntime({
      workingDir,
      approvalLevel: 5,
      overrides: { browserBackend: backend, skipLlamaHealthCheck: true },
    });
    try {
      const first = runtime.toolDescriptors;
      expect(runtime.toolDescriptors).toBe(first);
      writeConfig(CLOUD);
      await runtime.providerRegistry.setActive(CLOUD);
      const second = runtime.toolDescriptors;
      expect(second).not.toBe(first);
      expect(runtime.toolDescriptors).toBe(second);
    } finally {
      await runtime.shutdown();
    }
  });
});
