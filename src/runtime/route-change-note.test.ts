import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRuntime } from "./bootstrap.js";
import { resetConfigCache } from "../config/index.js";
import type { LlmStreamParams } from "../agent/step-executor.js";
import {
  SESSION_ROUTE_METADATA_KEY,
  readSessionRoute,
} from "../session/session-route.js";
import { SESSION_LLM_METADATA_KEY } from "../session/session-llm.js";
import type { BrowserBackend } from "../tools/browser/browser-backend.js";
import type { TraceEvent } from "../tracing/trace/trace-event.js";

/**
 * Hand QA of an RC: turn on a text-only cloud model refused
 * `vision.describe`; the operator switched to a model that can see, and
 * the next turn repeated the refusal — "the current model
 * (deepseek/deepseek-v4-flash) does not support images" — because the
 * transcript was the only place the model learned who it was. The
 * runtime now tells it, once, when the serving route changed.
 */
describe("route change note", () => {
  const AIML = "aimlapi";
  const OTHER = "openrouter";
  const LOCAL = "local-llama";
  let stateDir: string;
  let workingDir: string;
  const backend = {
    ensureReady: async () => {},
    shutdown: async () => {},
  } as unknown as BrowserBackend;

  const writeConfig = (activeTextProvider: string, aimlModel: string): void => {
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
              id: AIML,
              kind: "openai-compatible",
              baseUrl: "https://example.invalid",
              apiKey: "test-key",
              defaultChatModel: aimlModel,
            },
            {
              id: OTHER,
              kind: "openai-compatible",
              baseUrl: "https://example.invalid",
              apiKey: "test-key",
              defaultChatModel: "google/gemini-3-flash",
            },
            { id: LOCAL, kind: "llama-server", url: "http://127.0.0.1:8080" },
          ],
        },
      }),
      "utf8",
    );
    resetConfigCache();
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-route-note-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-route-note-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    writeConfig(AIML, "deepseek/deepseek-v4-flash");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
  });

  it("tells the model once when the provider or model changed between turns", async () => {
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
      const session = runtime.createSession();
      // The turn's own step prompts — sub-calls carry no tool catalog.
      const turnPrompts = async (text: string): Promise<string[]> => {
        prompts.length = 0;
        await runtime.runTurn(session, text, { maxSteps: 2 });
        const steps = prompts.filter((p) => p.includes("### tools"));
        expect(steps.length).toBeGreaterThan(0);
        return steps;
      };
      const notes = (steps: string[]): number =>
        steps.filter((p) => p.includes("[route changed]")).length;

      // First turn: nothing to compare against. Second: unchanged.
      expect(notes(await turnPrompts("describe /tmp/x.png"))).toBe(0);
      expect(
        readSessionRoute(runtime.sessionStore.load(session.id)!.metadata),
      ).toEqual({
        mode: "cloud",
        main: { providerId: AIML, model: "deepseek/deepseek-v4-flash" },
        worker: null,
      });
      expect(notes(await turnPrompts("again"))).toBe(0);

      // Model switch within the same provider.
      writeConfig(AIML, "anthropic/claude-sonnet-5");
      const switched = await turnPrompts("describe /tmp/x.png");
      expect(notes(switched)).toBe(switched.length);
      const step = switched[0]!;
      expect(step).toContain(
        "### route\n[route changed] You are now running as anthropic/claude-sonnet-5 on aimlapi (previously deepseek/deepseek-v4-flash on aimlapi). Capabilities now: reads images: yes. Tool refusals and limitations stated earlier in this conversation that were tied to the previous model no longer apply — re-check by calling the tool.",
      );
      // In the tail after the transcript — never in the stable prefix.
      expect(step.indexOf("### route")).toBeGreaterThan(
        step.lastIndexOf("### conversation"),
      );
      expect(step.indexOf("### route")).toBeGreaterThan(
        step.lastIndexOf("describe /tmp/x.png"),
      );

      // Once per change: the following turn carries no note.
      expect(notes(await turnPrompts("thanks"))).toBe(0);

      // Provider switch.
      writeConfig(OTHER, "anthropic/claude-sonnet-5");
      await runtime.providerRegistry.setActive(OTHER);
      const moved = await turnPrompts("and now?");
      expect(notes(moved)).toBe(moved.length);
      expect(moved[0]).toContain(
        "You are now running as google/gemini-3-flash on openrouter (previously anthropic/claude-sonnet-5 on aimlapi).",
      );
      expect(notes(await turnPrompts("ok"))).toBe(0);
    } finally {
      await runtime.shutdown();
    }
  });

  it("notes a session reopened onto a different route than it last ran on", async () => {
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
      const created = runtime.createSession();
      const session = {
        ...created,
        metadata: {
          ...created.metadata,
          [SESSION_ROUTE_METADATA_KEY]: {
            mode: "local",
            main: { providerId: LOCAL, model: "qwen-3.5-4b" },
            worker: null,
          },
        },
      };
      runtime.sessionStore.save(session);
      await runtime.runTurn(session, "hello", { maxSteps: 2 });
      const step = prompts.find((p) => p.includes("### tools"))!;
      expect(step).toContain(
        "[route changed] You are now running as deepseek/deepseek-v4-flash on aimlapi (previously qwen-3.5-4b on local-llama). Run mode: cloud (previously local).",
      );
    } finally {
      await runtime.shutdown();
    }
  });

  // ATO-138: the session's trace named the model the session had last
  // run on, not the one answering. `session_started` carried the stored
  // metadata, which holds the previous turn's stamp and route until the
  // turn's own save, and `turn_started` named no model at all.
  it("records the model each turn runs on in the session trace", async () => {
    const traced: TraceEvent[] = [];
    const boot = () =>
      createAgentRuntime({
        workingDir,
        approvalLevel: 5,
        traceDefault: true,
        handlers: { traceSinks: [(event) => traced.push(event)] },
        overrides: {
          browserBackend: backend,
          skipLlamaHealthCheck: true,
          llamaComplete: async () => ({
            content: JSON.stringify([{ tool: "reply", args: { text: "ok" } }]),
            timing: { promptTokens: 10, predictedTokens: 5 },
            slotId: 0,
            cacheReused: false,
          }),
        },
      });
    let sessionId = "";
    const turnModels = (): Array<string | null | undefined> =>
      traced
        .filter((e) => e.type === "turn_started" && e.sessionId === sessionId)
        .map((e) => (e.type === "turn_started" ? e.route?.main.model : null));

    const first = await boot();
    try {
      const session = first.createSession();
      sessionId = session.id;
      await first.runTurn(session, "hello", { maxSteps: 2 });
      // A switch inside the same process: the open file's next turn says so.
      writeConfig(AIML, "anthropic/claude-sonnet-5");
      await first.runTurn(session, "again", { maxSteps: 2 });
      expect(turnModels()).toEqual([
        "deepseek/deepseek-v4-flash",
        "anthropic/claude-sonnet-5",
      ]);
      expect(traced.find((e) => e.type === "turn_started")).toMatchObject({
        route: { mode: "cloud", main: { providerId: AIML }, worker: null },
      });
    } finally {
      await first.shutdown();
    }

    // Switched while nothing ran, then reopened by a fresh process: its
    // recorder opens at turn start, and the header must not name the
    // model the stored metadata still holds.
    writeConfig(AIML, "deepseek/deepseek-v4-flash");
    traced.length = 0;
    const second = await boot();
    try {
      const stored = second.sessionStore.load(sessionId)!;
      expect(readSessionRoute(stored.metadata)?.main.model).toBe(
        "anthropic/claude-sonnet-5",
      );
      await second.runTurn(stored, "back", { maxSteps: 2 });

      const header = traced.find(
        (e) => e.type === "session_started" && e.sessionId === sessionId,
      );
      expect(header?.type).toBe("session_started");
      const metadata =
        header?.type === "session_started" ? header.metadata : undefined;
      expect(metadata?.[SESSION_LLM_METADATA_KEY]).toEqual({
        providerId: AIML,
        chatModel: "deepseek/deepseek-v4-flash",
      });
      expect(readSessionRoute(metadata)?.main.model).toBe(
        "deepseek/deepseek-v4-flash",
      );
      expect(turnModels()).toEqual(["deepseek/deepseek-v4-flash"]);
    } finally {
      await second.shutdown();
    }
  });
});
