import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { ApprovalRequest } from "../approval/approval-gate.js";
import type { CompletionResult } from "../llm/llama-server-client.js";
import { resetConfigCache } from "../config/index.js";

import { formatLlamaUnreachableHint } from "../llm/llama-server-health.js";
import { LocalEngineDownError } from "../llm/reliability/index.js";
import {
  formatAgentEvent,
  formatCliApprovalPrompt,
  isApprovalAnswer,
  formatSkillsBannerValue,
} from "./run-agent.js";

const HINT = formatLlamaUnreachableHint("http://127.0.0.1:8080");

function transportError(message: string) {
  return {
    type: "llm_event" as const,
    event: {
      type: "step_error" as const,
      error: new Error(message),
      category: "transport" as const,
    },
  };
}

describe("isApprovalAnswer", () => {
  it("takes the offered keys, yes/no and an empty line, in any case", () => {
    for (const line of ["y", "Y", "yes", " YES ", "n", "no", "N", "s", "a", "", "  "]) {
      expect(isApprovalAnswer(line), JSON.stringify(line)).toBe(true);
    }
  });

  it("treats anything else as a message, not an answer", () => {
    for (const line of ["continue", "now say hi", "yes please", "nope", "always", "y n"]) {
      expect(isApprovalAnswer(line), line).toBe(false);
    }
  });
});

describe("formatCliApprovalPrompt", () => {
  const request = (category: ApprovalRequest["category"]): ApprovalRequest => ({
    approvalId: "a1",
    sessionId: "s1",
    tool: "tool.x",
    category,
    reason: "because",
  });

  it("names the category that can never be granted (issue #552)", () => {
    const email = formatCliApprovalPrompt(request("email"));
    expect(email).toContain("(e-mail send is never granted for the session)");
    expect(email).not.toContain("trust-config");
    expect(email).not.toContain("s = allow this kind");

    const fanout = formatCliApprovalPrompt(request("fusion_fanout"));
    expect(fanout).toContain(
      "(fusion · fan-out is never granted for the session)",
    );

    const trust = formatCliApprovalPrompt(request("trust_config"));
    expect(trust).toContain(
      "(agent trust config is never granted for the session)",
    );
  });

  it("offers the session grant and no note for a grantable category", () => {
    const prompt = formatCliApprovalPrompt(request("fs_write_home"));
    expect(prompt).toContain("s = allow this kind this session");
    expect(prompt).not.toContain("never granted");
  });
});

describe("formatAgentEvent llama hint", () => {
  it("turns a bare transport failure into something actionable on the local route", () => {
    const line = formatAgentEvent(transportError("fetch failed"), {
      llamaHint: HINT,
      hintShown: { value: false },
    });
    expect(line).toContain("! [transport] fetch failed");
    expect(line).toContain(
      "llama-server is not reachable at http://127.0.0.1:8080",
    );
    expect(line).toContain("atomic-agent models start");
    expect(line).toContain("config set localModels.url");
  });

  it("prints the hint once, not on every retry", () => {
    const hintShown = { value: false };
    const first = formatAgentEvent(transportError("fetch failed"), {
      llamaHint: HINT,
      hintShown,
    });
    const second = formatAgentEvent(transportError("fetch failed"), {
      llamaHint: HINT,
      hintShown,
    });
    expect(first).toContain("llama-server is not reachable");
    expect(second).toBe("  ! [transport] fetch failed");
  });

  it("stays out of the way on a cloud route", () => {
    // No hint is computed when the active text provider is not local —
    // a transport failure there points at the provider, not at llama.
    const line = formatAgentEvent(transportError("fetch failed"), {
      llamaHint: null,
      hintShown: { value: false },
    });
    expect(line).toBe("  ! [transport] fetch failed");
  });

  it("stays out of the way for non-transport failures", () => {
    const line = formatAgentEvent(
      {
        type: "llm_event",
        event: {
          type: "step_error",
          error: new Error("grammar rejected the completion"),
          category: "model" as never,
        },
      },
      { llamaHint: HINT, hintShown: { value: false } },
    );
    expect(line).toBe("  ! [model] grammar rejected the completion");
  });

  it("decorates loop_failed the same way", () => {
    const line = formatAgentEvent(
      {
        type: "loop_failed",
        error: new Error("fetch failed"),
        category: "transport" as never,
      },
      { llamaHint: HINT, hintShown: { value: false } },
    );
    expect(line).toContain("» loop failed [transport]: fetch failed");
    expect(line).toContain("llama-server is not reachable");
  });

  it("a turn ended because the local model is not running says so and names the start command (ATO-772)", () => {
    const line = formatAgentEvent(
      {
        type: "loop_failed",
        error: new LocalEngineDownError("local-llama"),
        category: "transport" as never,
      },
      { llamaHint: HINT, hintShown: { value: false } },
    );
    expect(line).toBe(
      "» loop failed [transport]: The local model isn't running.\n    Start it with: atomic-agent models start",
    );
  });
});

describe("formatLlamaUnreachableHint", () => {
  it("names the URL, the start command and the config key", () => {
    const hint = formatLlamaUnreachableHint("http://10.0.0.4:9090");
    expect(hint).toContain("http://10.0.0.4:9090");
    expect(hint).toContain("atomic-agent models start");
    expect(hint).toContain("localModels.url");
  });
});

/**
 * Raw model output the stubbed llama-server replays on every step, after
 * the one-shot `script` entries (one per step, in order) run out.
 */
const model = vi.hoisted(() => ({ emits: "", script: [] as string[] }));

/** The options `runAgentCommand` handed `runtime.runTurn`, per turn. */
const turnOptions = vi.hoisted(() => [] as Array<Record<string, unknown>>);

/** The user message of each turn, in the order the turns ran. */
const turnMessages = vi.hoisted(() => [] as string[]);

/** When set, every turn waits on it before it starts running. */
const turnGate = vi.hoisted(() => ({ wait: null as Promise<void> | null }));

// `runAgentCommand` boots the real runtime and takes no injection seam of
// its own, so the bootstrap module is wrapped to supply the same
// `overrides` the HTTP harness uses. Everything else — tool registry,
// agent loop, session status transitions, the exit-code branch under
// test — stays on the production path. Nothing may be imported from
// `../http/test-harness.js` in here: that module imports the very module
// being mocked, so awaiting it inside the factory re-enters the mock and
// deadlocks.
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
    // Post-turn reflection shares the completion seam but expects prose,
    // not a tool call; feeding it the step payload would have it parse
    // the fixture as notes.
    if (params.sessionId.startsWith("reflection:")) return completion("");
    return completion(model.script.shift() ?? model.emits);
  };
  return {
    ...actual,
    createAgentRuntime: async (
      options: Parameters<typeof actual.createAgentRuntime>[0],
    ) => {
      const runtime = await actual.createAgentRuntime({
        ...options,
        // No browser override: `PlaywrightBackend` launches lazily and
        // these turns never touch a browser tool, so nothing spawns.
        overrides: {
          skipLlamaHealthCheck: true,
          disableStreaming: true,
          llamaComplete: complete,
        },
      });
      // Record what the command asks of each turn; the turn itself still
      // runs on the production path.
      const runTurn = runtime.runTurn;
      return Object.assign(runtime, {
        runTurn: async (...args: Parameters<typeof runTurn>) => {
          turnOptions.push({ ...(args[2] ?? {}) });
          turnMessages.push(args[1]);
          if (turnGate.wait) await turnGate.wait;
          return runTurn(...args);
        },
      });
    },
  };
});

const { runAgentCommand } = await import("./run-agent.js");

describe("runAgentCommand exit codes", () => {
  let stateDir: string;
  let workingDir: string;
  let stderr = "";
  const realStdin = process.stdin;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-cli-run-state-"));
    workingDir = mkdtempSync(join(tmpdir(), "atomic-cli-run-cwd-"));
    mkdirSync(join(workingDir, ".atomic-agent", "skills"), { recursive: true });
    writeFileSync(join(workingDir, "note.txt"), "hello\n", "utf8");
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    process.env.ATOMIC_AGENT_GRAMMARS_DIR = join(process.cwd(), "grammars");
    resetConfigCache();
    model.emits = "";
    model.script = [];
    stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "stdin", {
      value: realStdin,
      configurable: true,
    });
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

  it("exits 2 when --cwd points at a path that does not exist", async () => {
    const missing = join(workingDir, "definitely-not-here");
    const code = await runAgentCommand(["--cwd", missing]);
    expect(code).toBe(2);
    expect(stderr).toContain(`--cwd is not a directory: ${missing}`);
  });

  it("exits 2 when --working-dir points at a file rather than a directory", async () => {
    const file = join(workingDir, "note.txt");
    const code = await runAgentCommand(["--working-dir", file]);
    expect(code).toBe(2);
    expect(stderr).toContain(`--working-dir is not a directory: ${file}`);
  });

  it("exits 2 on an unknown flag", async () => {
    const code = await runAgentCommand(["--nope"]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown flag: --nope");
  });

  it("exits 1 when the turn exhausts the step budget and the session stalls", async () => {
    // A non-terminal tool on every step: the loop never reaches `reply`
    // or `finish`, so it runs the budget out and lands on `stalled`.
    model.emits = JSON.stringify({
      tool: "os.fs.read",
      args: { path: "note.txt" },
    });
    feedStdin(["read the note\n"]);
    const code = await runAgentCommand([
      "--cwd",
      workingDir,
      "--max-steps",
      "2",
      "--no-approval",
    ]);
    expect(stderr).toContain('"status": "stalled"');
    expect(code).toBe(1);
  }, 60_000);

  it("still exits 0 when the same turn ends on a reply", async () => {
    model.emits = JSON.stringify({
      tool: "reply",
      args: { text: "the note says hello" },
    });
    feedStdin(["read the note\n"]);
    const code = await runAgentCommand([
      "--cwd",
      workingDir,
      "--max-steps",
      "2",
      "--no-approval",
    ]);
    expect(stderr).not.toContain('"status": "stalled"');
    expect(code).toBe(0);
  }, 60_000);

  it("leaves the step ceiling to the runtime without --max-steps", async () => {
    // An explicit `maxSteps` is a hard ceiling in the runtime; filling in
    // `agent.maxSteps` (the leg length) stopped every task at the first leg.
    turnOptions.length = 0;
    model.emits = JSON.stringify({ tool: "reply", args: { text: "hi" } });
    feedStdin(["hello\n"]);
    const code = await runAgentCommand(["--cwd", workingDir, "--no-approval"]);
    expect(code).toBe(0);
    expect(turnOptions).toHaveLength(1);
    expect("maxSteps" in turnOptions[0]!).toBe(false);
  }, 60_000);

  it("passes --max-steps through as the task ceiling", async () => {
    turnOptions.length = 0;
    model.emits = JSON.stringify({ tool: "reply", args: { text: "hi" } });
    feedStdin(["hello\n"]);
    const code = await runAgentCommand([
      "--cwd",
      workingDir,
      "--max-steps",
      "7",
      "--no-approval",
    ]);
    expect(code).toBe(0);
    expect(turnOptions).toHaveLength(1);
    expect(turnOptions[0]!.maxSteps).toBe(7);
  }, 60_000);

  it("runs every stdin line in order, even lines that arrive mid-turn (ATO-781)", async () => {
    // A driver writes the task and its follow-ups up front. The first
    // turn is held until stdin has hit EOF, so the follow-ups arrive
    // while it runs and EOF lands before it ends.
    turnOptions.length = 0;
    turnMessages.length = 0;
    model.emits = JSON.stringify({ tool: "reply", args: { text: "ok" } });
    const stdin = Readable.from(["the task\n", "continue\n", "and wrap up\n"]);
    Object.defineProperty(process, "stdin", {
      value: stdin,
      configurable: true,
    });
    turnGate.wait = new Promise<void>((resolveGate) => {
      stdin.once("end", () => resolveGate());
    });
    try {
      const code = await runAgentCommand([
        "--cwd",
        workingDir,
        "--no-approval",
      ]);
      expect(code).toBe(0);
    } finally {
      turnGate.wait = null;
    }
    expect(turnMessages).toEqual(["the task", "continue", "and wrap up"]);
    expect(stderr).toContain('"turnCount": 3');
  }, 60_000);

  describe("approval answers come from the same stdin queue (ATO-802)", () => {
    const WRITE = JSON.stringify({
      tool: "os.fs.write",
      args: { path: "out.txt", content: "written" },
    });
    const REPLY = (text: string): string =>
      JSON.stringify({ tool: "reply", args: { text } });

    it("takes a piped y for the approval and keeps the next message for the next turn", async () => {
      // Default approval level 1 asks before a workspace write. The task,
      // the answer and the next message arrive in one chunk, all read
      // before the approval opens.
      turnMessages.length = 0;
      model.script = [WRITE, REPLY("wrote it")];
      model.emits = REPLY("ok");
      feedStdin(["write the file\ny\nnow say hi\n"]);
      const code = await runAgentCommand(["--cwd", workingDir]);
      expect(code).toBe(0);
      expect(stderr).toContain("approval required for tool: os.fs.write");
      expect(readFileSync(join(workingDir, "out.txt"), "utf8")).toBe("written");
      expect(turnMessages).toEqual(["write the file", "now say hi"]);
      expect(stderr).toContain('"turnCount": 2');
    }, 60_000);

    it("denies without eating a queued message that is not an answer", async () => {
      // The driver pipes two messages and no answer: the approval must
      // not swallow "now say hi" as its (deny) answer.
      turnMessages.length = 0;
      model.script = [WRITE, REPLY("could not write")];
      model.emits = REPLY("ok");
      feedStdin(["write the file\nnow say hi\n"]);
      const code = await runAgentCommand(["--cwd", workingDir]);
      expect(code).toBe(0);
      expect(stderr).toContain("approval required for tool: os.fs.write");
      expect(stderr).toContain("not an answer, kept as the next message");
      expect(existsSync(join(workingDir, "out.txt"))).toBe(false);
      expect(turnMessages).toEqual(["write the file", "now say hi"]);
      expect(stderr).toContain('"turnCount": 2');
    }, 60_000);

    it("takes a piped n as the answer: denied, and it is not a turn", async () => {
      turnMessages.length = 0;
      model.script = [WRITE, REPLY("could not write")];
      model.emits = REPLY("ok");
      feedStdin(["write the file\nn\nnow say hi\n"]);
      const code = await runAgentCommand(["--cwd", workingDir]);
      expect(code).toBe(0);
      expect(existsSync(join(workingDir, "out.txt"))).toBe(false);
      expect(turnMessages).toEqual(["write the file", "now say hi"]);
      expect(stderr).toContain('"turnCount": 2');
    }, 60_000);

    it("denies at EOF before an answer", async () => {
      turnMessages.length = 0;
      model.script = [WRITE, REPLY("could not write")];
      model.emits = REPLY("ok");
      feedStdin(["write the file\n"]);
      const code = await runAgentCommand(["--cwd", workingDir]);
      expect(code).toBe(0);
      expect(existsSync(join(workingDir, "out.txt"))).toBe(false);
      expect(turnMessages).toEqual(["write the file"]);
    }, 60_000);

    it("denies when the approval prompt fails, and later stdin lines still run", async () => {
      turnMessages.length = 0;
      model.script = [WRITE, REPLY("could not write")];
      model.emits = REPLY("ok");
      // The prompt's own stderr write throws once: the prompt fails
      // before it reads an answer.
      let failed = false;
      vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
        const text = typeof chunk === "string" ? chunk : String(chunk);
        if (!failed && text.includes("approval required for tool")) {
          failed = true;
          throw new Error("stderr is gone");
        }
        stderr += text;
        return true;
      });
      feedStdin(["write the file\nnow say hi\n"]);
      const code = await runAgentCommand(["--cwd", workingDir]);
      expect(code).toBe(0);
      expect(failed).toBe(true);
      expect(stderr).toContain("approval prompt failed (stderr is gone); denied");
      expect(existsSync(join(workingDir, "out.txt"))).toBe(false);
      expect(turnMessages).toEqual(["write the file", "now say hi"]);
      expect(stderr).toContain('"turnCount": 2');
    }, 60_000);
  });
});

/**
 * The `skills:` row of the startup banner. It has always printed the
 * catalog the prompt got, which is not the install once
 * `skills.catalogTokenBudget` starts cutting (issue #466 — fixed for
 * the prompt in PR #471, not for anything reading the runtime).
 */
describe("the run banner skills row", () => {
  it("names the omitted count and the knob when the budget cut the catalog", () => {
    expect(formatSkillsBannerValue(17, 16)).toBe(
      "17 installed, 16 more not shown (skills.catalogTokenBudget)",
    );
  });

  it("is byte-identical to the pre-fix row when nothing was dropped", () => {
    expect(formatSkillsBannerValue(33, 0)).toBe("33 installed");
    expect(formatSkillsBannerValue(0, 0)).toBe("0 installed");
    expect(formatSkillsBannerValue(33, 0)).not.toContain(
      "skills.catalogTokenBudget",
    );
  });
});
