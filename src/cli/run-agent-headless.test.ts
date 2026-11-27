import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { CompletionResult } from "../llm/llama-server-client.js";
import { resetConfigCache } from "../config/index.js";

/** ATO-2307: `atomic-agent run` for scripts, on the production turn path. */

const model = vi.hoisted(() => ({ emits: "" }));
const turnMessages = vi.hoisted(() => [] as string[]);
const turnSessions = vi.hoisted(() => [] as string[]);

// Same wrapping as run-agent.test.ts: the real runtime with a scripted
// local model, and each turn's message and chat id recorded.
vi.mock("../runtime/bootstrap.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../runtime/bootstrap.js")>();
  const completion = (content: string): CompletionResult => ({
    content,
    reasoningContent: "",
    stop: true,
    truncated: false,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 5, predictedTokens: 3 },
    cacheHitTokens: 0,
    slotId: 0,
    modelId: null,
  });
  const complete = async (params: { sessionId: string }): Promise<CompletionResult> =>
    completion(params.sessionId.startsWith("reflection:") ? "" : model.emits);
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
      const runTurn = runtime.runTurn;
      return Object.assign(runtime, {
        runTurn: async (...args: Parameters<typeof runTurn>) => {
          turnSessions.push(args[0].id);
          turnMessages.push(args[1]);
          return runTurn(...args);
        },
      });
    },
  };
});

const { runAgentCommand } = await import("./run-agent.js");

const reply = (text: string): string =>
  JSON.stringify({ tool: "reply", args: { text } });

describe("run in headless mode (ATO-2307)", () => {
  let stateDir: string;
  let workingDir: string;
  let stdout = "";
  let stderr = "";
  const realStdin = process.stdin;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-cli-headless-state-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-cli-headless-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
    model.emits = reply("hello there");
    turnMessages.length = 0;
    turnSessions.length = 0;
    stdout = "";
    stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    });
    feedStdin([]);
  });

  afterEach(() => {
    Object.defineProperty(process, "stdin", { value: realStdin, configurable: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workingDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.ATOMIC_AGENT_GRAMMARS_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  function feedStdin(lines: string[]): void {
    Object.defineProperty(process, "stdin", {
      value: Readable.from(lines),
      configurable: true,
    });
  }

  const jsonLines = (): Array<Record<string, unknown>> =>
    stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  const base = (): string[] => ["--cwd", workingDir, "--no-approval"];

  it("runs one turn with the prompt argument and leaves stdin lines alone", async () => {
    feedStdin(["a piped line\n"]);
    const code = await runAgentCommand([...base(), "say", "hi"]);
    expect(code).toBe(0);
    expect(turnMessages).toEqual(["say hi"]);
    expect(stdout).toBe("hello there\n");
  }, 60_000);

  it("streams JSONL events: start first, the reply as a message, the result last", async () => {
    const code = await runAgentCommand([...base(), "--output-format", "stream-json", "say hi"]);
    expect(code).toBe(0);
    const events = jsonLines();
    expect(events[0]).toMatchObject({ type: "start", resumed: false, cwd: workingDir });
    expect(events.map((e) => e.type)).toContain("turn_started");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "message", text: "hello there", progress: false }),
    );
    const last = events.at(-1)!;
    expect(last).toMatchObject({
      type: "result",
      isError: false,
      result: "hello there",
      turns: 1,
      sessionId: events[0]!.sessionId,
    });
    // stdout is JSON only: the plain reply line is not printed.
    expect(stdout.split("\n")).not.toContain("hello there");
  }, 60_000);

  it("--json is the stream; --output-format json prints only the result object", async () => {
    expect(await runAgentCommand([...base(), "--json", "say hi"])).toBe(0);
    expect(jsonLines()[0]!.type).toBe("start");
    stdout = "";
    expect(await runAgentCommand([...base(), "--output-format", "json", "say hi"])).toBe(0);
    const events = jsonLines();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "result", result: "hello there" });
  }, 60_000);

  it("writes the last reply, newlines kept, to the -o file", async () => {
    model.emits = reply("line one\nline two");
    const out = join(workingDir, "last.txt");
    const code = await runAgentCommand([...base(), "-o", out, "say hi"]);
    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("line one\nline two");
    expect(stdout).toBe("line one line two\n");
  }, 60_000);

  it("--resume and --continue go on with the same saved chat", async () => {
    expect(await runAgentCommand([...base(), "--output-format", "json", "first"])).toBe(0);
    const first = jsonLines()[0]!;
    const id = first.sessionId as string;
    stdout = "";
    expect(await runAgentCommand([...base(), "--resume", id, "--json", "second"])).toBe(0);
    const resumed = jsonLines();
    expect(resumed[0]).toMatchObject({ type: "start", sessionId: id, resumed: true });
    expect(resumed.at(-1)).toMatchObject({ type: "result", sessionId: id, turns: 2 });
    stdout = "";
    expect(await runAgentCommand([...base(), "--continue", "--output-format", "json", "third"])).toBe(0);
    expect(jsonLines()[0]).toMatchObject({ sessionId: id, turns: 3 });
    expect(turnSessions).toEqual([id, id, id]);
  }, 90_000);

  it("fails with a JSON result when the chat to resume does not exist", async () => {
    const code = await runAgentCommand([...base(), "--resume", "s-missing", "--output-format", "json", "x"]);
    expect(code).toBe(1);
    expect(jsonLines()).toEqual([
      expect.objectContaining({ type: "result", isError: true, error: "no chat with id s-missing" }),
    ]);
    expect(turnMessages).toEqual([]);
  }, 60_000);

  it("refuses a per-turn model on the local provider before anything boots", async () => {
    const code = await runAgentCommand([...base(), "--model", "gpt-5", "say hi"]);
    expect(code).toBe(2);
    expect(stderr).toContain("a per-turn model works on cloud providers only");
    expect(turnMessages).toEqual([]);
  });

  it("refuses --resume with --incognito as a usage error", async () => {
    const code = await runAgentCommand([...base(), "--incognito", "--continue"]);
    expect(code).toBe(2);
    expect(stderr).toContain("cannot run with --resume or --continue");
  });
});
