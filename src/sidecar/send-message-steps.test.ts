import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CompletionResult } from "../llm/llama-server-client.js";
import {
  getUserConfigPath,
  resetConfigCache,
  USER_CONFIG_DEFAULTS,
  writeUserConfigFileSync,
} from "../config/index.js";
import type { SidecarMessage } from "./sidecar-events.js";

/**
 * Issue #547 — `send_message` filled in `agent.maxSteps` (the leg
 * length) whenever the client sent no `maxSteps`. The runtime treats an
 * explicit `maxSteps` as the whole-task ceiling, so every sidecar task
 * stopped after one leg. The CLI had the same bug (see `run-agent.ts`).
 *
 * The sidecar is driven the way the host drives it — NDJSON on the real
 * stdin, responses read off stdout — and the options each turn receives
 * are recorded on the way into `executeTurn`.
 */

/** The options `send_message` handed `runtime.executeTurn`, per turn. */
const turnOptions = vi.hoisted(() => [] as Array<Record<string, unknown>>);

// Same seam as `run-agent.test.ts`: the real runtime, with the completion
// stubbed and `executeTurn` wrapped to record its options.
vi.mock("../runtime/bootstrap.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../runtime/bootstrap.js")>();
  const completion = (content: string): CompletionResult => ({
    content,
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
  const complete = async (params: {
    sessionId: string;
  }): Promise<CompletionResult> => {
    if (params.sessionId.startsWith("reflection:")) return completion("");
    return completion(JSON.stringify({ tool: "reply", args: { text: "hi" } }));
  };
  return {
    ...actual,
    createAgentRuntime: async (
      options: Parameters<typeof actual.createAgentRuntime>[0],
    ) => {
      const runtime = await actual.createAgentRuntime({
        ...options,
        overrides: {
          skipLlamaHealthCheck: true,
          disableStreaming: true,
          llamaComplete: complete,
        },
      });
      const executeTurn = runtime.executeTurn;
      return Object.assign(runtime, {
        executeTurn: (...args: Parameters<typeof executeTurn>) => {
          turnOptions.push({ ...(args[2] ?? {}) });
          return executeTurn(...args);
        },
      });
    },
  };
});

const { bootstrapSidecar } = await import("./main.js");

describe("sidecar send_message — step ceiling", () => {
  let stateDir: string;
  let workingDir: string;
  let previousStateDir: string | undefined;
  let stdout: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-sidecar-steps-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-sidecar-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    previousStateDir = process.env.ATOMIC_AGENT_STATE_DIR;
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      analytics: { enabled: false },
    });
    resetConfigCache();
    turnOptions.length = 0;

    // `start_session` probes the local llama-server; nothing answers.
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    stdout = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    if (previousStateDir === undefined) {
      delete process.env.ATOMIC_AGENT_STATE_DIR;
    } else {
      process.env.ATOMIC_AGENT_STATE_DIR = previousStateDir;
    }
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
  });

  const parsed = (): SidecarMessage[] =>
    stdout
      .join("")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as SidecarMessage];
        } catch {
          return [];
        }
      });

  const request = async (
    id: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<SidecarMessage> => {
    process.stdin.emit(
      "data",
      `${JSON.stringify({ kind: "request", id, type, payload })}\n`,
    );
    const deadline = Date.now() + 20_000;
    for (;;) {
      const response = parsed().find(
        (m) => m.kind === "response" && m.correlationId === id,
      );
      if (response) return response;
      if (Date.now() > deadline) throw new Error(`no response to ${type}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  /**
   * Boot the sidecar, run one `send_message`, and detach the listeners
   * `bootstrapSidecar` added to the process-wide stdin/stdout (see
   * `local-probe-gating.test.ts` for why).
   */
  const sendOne = async (
    extra: Record<string, unknown>,
  ): Promise<SidecarMessage> => {
    const before = new Map<string, unknown[]>([
      ["stdin:data", process.stdin.listeners("data").slice()],
      ["stdin:end", process.stdin.listeners("end").slice()],
      ["stdout:error", process.stdout.listeners("error").slice()],
      ["stdout:close", process.stdout.listeners("close").slice()],
    ]);
    const { shutdown } = await bootstrapSidecar();
    try {
      const started = await request("req-start", "start_session", {
        workingDir,
      });
      expect(started.kind === "response" && started.ok).toBe(true);
      const sessionId =
        started.kind === "response" && started.ok
          ? (started.payload as { sessionId: string }).sessionId
          : "";
      return await request("req-send", "send_message", {
        sessionId,
        text: "hello",
        ...extra,
      });
    } finally {
      for (const [key, kept] of before) {
        const [target, event] = key.split(":") as ["stdin" | "stdout", string];
        const emitter = target === "stdin" ? process.stdin : process.stdout;
        for (const listener of emitter.listeners(event)) {
          if (!kept.includes(listener)) {
            emitter.removeListener(event, listener as () => void);
          }
        }
      }
      await shutdown();
    }
  };

  it("leaves the step ceiling to the runtime when the client sends none", async () => {
    const response = await sendOne({});
    expect(response.kind === "response" && response.ok).toBe(true);
    expect(turnOptions).toHaveLength(1);
    expect("maxSteps" in turnOptions[0]!).toBe(false);
  }, 60_000);

  it("treats a null maxSteps as not given", async () => {
    const response = await sendOne({ maxSteps: null });
    expect(response.kind === "response" && response.ok).toBe(true);
    expect(turnOptions).toHaveLength(1);
    expect("maxSteps" in turnOptions[0]!).toBe(false);
  }, 60_000);

  it("passes a client maxSteps through as the task ceiling", async () => {
    const response = await sendOne({ maxSteps: 7 });
    expect(response.kind === "response" && response.ok).toBe(true);
    expect(turnOptions).toHaveLength(1);
    expect(turnOptions[0]!.maxSteps).toBe(7);
  }, 60_000);
});
