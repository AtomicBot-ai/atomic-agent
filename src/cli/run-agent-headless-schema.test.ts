import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { CompletionResult } from "../llm/llama-server-client.js";
import { resetConfigCache } from "../config/index.js";

/**
 * ATO-2440: `run --output-schema`, `--allowed-tools`, prompt + stdin,
 * `--ephemeral` and tokens in `result.usage`, on the production turn path
 * with a scripted local model (the same wrapping as run-agent-headless.test.ts).
 */

const model = vi.hoisted(() => ({ emits: "", shaped: "" }));
const shapeCalls = vi.hoisted(() => [] as Array<{ grammar: string; prompt: string }>);
const turns = vi.hoisted(
  () => [] as Array<{ message: string; toolFilter?: (name: string) => boolean }>,
);

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
  const complete = async (params: {
    sessionId: string;
    grammar?: string;
    prompt?: string;
  }): Promise<CompletionResult> => {
    if (params.sessionId.startsWith("reflection:")) return completion("");
    if (params.sessionId.startsWith("structured-answer:")) {
      shapeCalls.push({ grammar: params.grammar ?? "", prompt: params.prompt ?? "" });
      return completion(model.shaped);
    }
    return completion(model.emits);
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
      const runTurn = runtime.runTurn;
      return Object.assign(runtime, {
        runTurn: async (...args: Parameters<typeof runTurn>) => {
          turns.push({
            message: args[1],
            ...(args[2]?.toolFilter ? { toolFilter: args[2].toolFilter } : {}),
          });
          return runTurn(...args);
        },
      });
    },
  };
});

const { runAgentCommand } = await import("./run-agent.js");

const reply = (text: string): string =>
  JSON.stringify({ tool: "reply", args: { text } });

const SCHEMA = {
  type: "object",
  properties: { files: { type: "integer" } },
  required: ["files"],
  additionalProperties: false,
};

describe("run headless leftovers (ATO-2440)", () => {
  let stateDir: string;
  let workingDir: string;
  let stdout = "";
  let stderr = "";
  const realStdin = process.stdin;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-cli-schema-state-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-cli-schema-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
    model.emits = reply("hello there");
    model.shaped = "";
    shapeCalls.length = 0;
    turns.length = 0;
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

  function feedStdin(chunks: string[]): void {
    Object.defineProperty(process, "stdin", {
      value: Readable.from(chunks),
      configurable: true,
    });
  }

  const jsonLines = (): Array<Record<string, unknown>> =>
    stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  const base = (): string[] => ["--cwd", workingDir, "--no-approval"];

  const schemaFile = (): string => {
    const path = join(workingDir, "schema.json");
    writeFileSync(path, JSON.stringify(SCHEMA), "utf8");
    return path;
  };

  it("takes a reply that already matches the schema, with no side call", async () => {
    model.emits = reply('{"files": 12}');
    const code = await runAgentCommand([
      ...base(), "--output-schema", schemaFile(), "--output-format", "json", "count files",
    ]);
    expect(code).toBe(0);
    expect(jsonLines()[0]).toMatchObject({
      type: "result",
      isError: false,
      structuredOutput: { files: 12 },
    });
    expect(shapeCalls).toEqual([]);
    // The turn was asked for the JSON shape.
    expect(turns[0]!.message).toContain("count files");
    expect(turns[0]!.message).toContain(JSON.stringify(SCHEMA));
  }, 60_000);

  it("puts a prose reply into the schema with a grammar-held side call on a local model", async () => {
    model.emits = reply("There are 7 files in src.");
    model.shaped = '{"files": 7}';
    const out = join(workingDir, "answer.json");
    const code = await runAgentCommand([
      ...base(), "--output-schema", JSON.stringify(SCHEMA), "-o", out, "count files",
    ]);
    expect(code).toBe(0);
    expect(shapeCalls).toHaveLength(1);
    expect(shapeCalls[0]!.grammar).toContain("root ::=");
    expect(shapeCalls[0]!.prompt).toContain("There are 7 files in src.");
    // Text mode prints the settled JSON, not the prose reply.
    expect(stdout).toBe('{"files":7}\n');
    expect(readFileSync(out, "utf8")).toBe('{"files":7}');
  }, 60_000);

  it("exits 3 with schemaError when the answer cannot be put into the schema", async () => {
    model.emits = reply("no idea");
    model.shaped = '{"files": "many"}';
    const code = await runAgentCommand([
      ...base(), "--output-schema", schemaFile(), "--json", "count files",
    ]);
    expect(code).toBe(3);
    const last = jsonLines().at(-1)!;
    expect(last).toMatchObject({ type: "result", isError: true, schemaError: expect.any(String) });
    expect(last).not.toHaveProperty("structuredOutput");
  }, 60_000);

  it("refuses a schema that is not JSON before anything boots", async () => {
    const code = await runAgentCommand([...base(), "--output-schema", "{not json", "x"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--output-schema");
    expect(turns).toEqual([]);
  });

  it("narrows every turn's tools with --allowed-tools and --disallowed-tools", async () => {
    const code = await runAgentCommand([
      ...base(), "--allowed-tools", "os.fs.*,Bash", "--disallowed-tools", "os.fs.write", "look",
    ]);
    expect(code).toBe(0);
    const filter = turns[0]!.toolFilter!;
    expect(filter).toBeTypeOf("function");
    expect(filter("os.fs.read")).toBe(true);
    expect(filter("os.shell.run")).toBe(true);
    expect(filter("os.fs.write")).toBe(false);
    expect(filter("browser.open")).toBe(false);
    expect(filter("reply")).toBe(true);
  }, 60_000);

  it("refuses an unknown tool name as a usage error", async () => {
    const code = await runAgentCommand([...base(), "--disallowed-tools", "Not A Tool!", "x"]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown tool name");
    expect(turns).toEqual([]);
  });

  it("adds piped stdin to the prompt argument", async () => {
    feedStdin(["line one\n", "line two\n"]);
    const code = await runAgentCommand([...base(), "explain", "this"]);
    expect(code).toBe(0);
    expect(turns.map((t) => t.message)).toEqual([
      "explain this\n\n<stdin>\nline one\nline two\n</stdin>",
    ]);
  }, 60_000);

  it("--ephemeral deletes the chat when the run ends", async () => {
    expect(await runAgentCommand([...base(), "--ephemeral", "first"])).toBe(0);
    stderr = "";
    const code = await runAgentCommand([...base(), "--continue", "second"]);
    expect(code).toBe(1);
    expect(stderr).toContain("there is no saved chat");
  }, 90_000);

  it("refuses --ephemeral with --continue", async () => {
    const code = await runAgentCommand([...base(), "--ephemeral", "--continue", "x"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--ephemeral");
  });

  it("reports the turn's prompt and completion tokens in result.usage", async () => {
    const code = await runAgentCommand([...base(), "--output-format", "json", "say hi"]);
    expect(code).toBe(0);
    const usage = jsonLines()[0]!.usage as Record<string, unknown>;
    expect(usage.promptTokens).toBeGreaterThan(0);
    expect(usage.completionTokens).toBeGreaterThan(0);
  }, 60_000);
});
