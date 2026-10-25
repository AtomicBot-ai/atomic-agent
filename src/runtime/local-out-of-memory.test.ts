import { describe, expect, it, vi } from "vitest";
import type { ApprovalDecision } from "../approval/index.js";
import {
  LOCAL_MODEL_RESTART_TOOL,
  PICK_SMALLER_MODEL_REASON,
  createLocalOutOfMemoryPort,
  readLocalOutOfMemory,
  type LocalOutOfMemoryReaders,
} from "./local-out-of-memory.js";

const cfg = (mode: "managed" | "external") =>
  ({
    localModels: { mode },
    paths: { localModelsDataDir: "/state/models" },
  }) as never;

const LAUNCH = "[atomic-agent] launch: model gemma-4-31b (gemma4, 60 layers)";
const OOM_LOG = [LAUNCH, "E error: Insufficient Memory (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)"].join("\n");

function readers(log: string, launchContextSize: number | null = 262_144): LocalOutOfMemoryReaders {
  return { readLog: vi.fn(() => log), launchContextSize: vi.fn(() => launchContextSize) };
}

describe("readLocalOutOfMemory (ATO-334)", () => {
  it("the managed model's current run logged out of memory: the window it was started with", () => {
    const r = readers(OOM_LOG);
    expect(readLocalOutOfMemory("local-llama", cfg("managed"), "local-llama", r)).toEqual({ contextWindow: 262_144 });
    expect(r.readLog).toHaveBeenCalledWith("/state/models");
  });

  it("an out-of-memory from an earlier launch does not count", () => {
    const log = [OOM_LOG, LAUNCH, "I srv llama_server: model loaded"].join("\n");
    expect(readLocalOutOfMemory("local-llama", cfg("managed"), "local-llama", readers(log))).toBeNull();
  });

  it("another fault is not out of memory", () => {
    const log = [LAUNCH, "E srv start: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 19091"].join("\n");
    expect(readLocalOutOfMemory("local-llama", cfg("managed"), "local-llama", readers(log))).toBeNull();
  });

  it("an unknown window reads 0", () => {
    expect(readLocalOutOfMemory("local-llama", cfg("managed"), "local-llama", readers(OOM_LOG, null))).toEqual({ contextWindow: 0 });
  });

  it("an error that names no link is the active provider's", () => {
    expect(readLocalOutOfMemory(undefined, cfg("managed"), "local-llama", readers(OOM_LOG))).toEqual({ contextWindow: 262_144 });
    expect(readLocalOutOfMemory(undefined, cfg("managed"), "openrouter", readers(OOM_LOG))).toBeNull();
  });

  it.each([["openrouter"], ["my-llama"]])("link %s is not the managed model", (id) => {
    const r = readers(OOM_LOG);
    expect(readLocalOutOfMemory(id, cfg("managed"), "local-llama", r)).toBeNull();
    expect(r.readLog).not.toHaveBeenCalled();
  });

  it("external mode is the operator's server: never judged", () => {
    const r = readers(OOM_LOG);
    expect(readLocalOutOfMemory("local-llama", cfg("external"), "local-llama", r)).toBeNull();
    expect(r.readLog).not.toHaveBeenCalled();
  });

  it("a log that cannot be read is no verdict", () => {
    const r: LocalOutOfMemoryReaders = {
      readLog: () => { throw new Error("EACCES"); },
      launchContextSize: () => 0,
    };
    expect(readLocalOutOfMemory("local-llama", cfg("managed"), "local-llama", r)).toBeNull();
  });
});

describe("createLocalOutOfMemoryPort (ATO-334)", () => {
  const question = {
    questionId: "q1",
    sessionId: "s1",
    contextWindow: 262_144,
    nextContextWindow: 131_072,
    message: "The model ran out of memory with a context window of 262144 tokens. Restart it with a smaller window (131072 tokens)?",
  };

  function build(decision: Omit<ApprovalDecision, "approvalId">, restarter: ((n: number, s: AbortSignal) => Promise<boolean>) | null = null) {
    const request = vi.fn(async () => ({ approvalId: "q1", ...decision }));
    const port = createLocalOutOfMemoryPort({
      readConfig: () => cfg("managed"),
      activeTextProvider: () => "local-llama",
      approvals: { request } as never,
      restarter: () => restarter,
      readers: readers(OOM_LOG),
    });
    return { port, request };
  }

  it("asks through the approval surface under the question's id", async () => {
    const { port, request } = build({ approved: true });
    const signal = new AbortController().signal;
    expect(await port.ask(question, signal)).toBe("restart_smaller");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "q1",
        sessionId: "s1",
        tool: LOCAL_MODEL_RESTART_TOOL,
        reason: question.message,
      }),
      { signal },
    );
  });

  it("a Deny is a cancel; a Deny saying pick_smaller_model is that", async () => {
    expect(await build({ approved: false }).port.ask(question, new AbortController().signal)).toBe("cancel");
    expect(
      await build({ approved: false, reason: PICK_SMALLER_MODEL_REASON }).port.ask(question, new AbortController().signal),
    ).toBe("pick_smaller_model");
  });

  it("a refusal nobody made means nobody is there: restart as unattended", async () => {
    expect(
      await build({ approved: false, automatic: true, reason: "no surface" }).port.ask(question, new AbortController().signal),
    ).toBe("restart_smaller");
  });

  it("restarts only through a registered restarter", async () => {
    const restarter = vi.fn(async () => true);
    const withOne = build({ approved: true }, restarter).port;
    expect(withOne.canRestart()).toBe(true);
    expect(await withOne.restart(131_072, new AbortController().signal)).toBe(true);
    expect(restarter).toHaveBeenCalledWith(131_072, expect.any(AbortSignal));
    const without = build({ approved: true }).port;
    expect(without.canRestart()).toBe(false);
    expect(await without.restart(131_072, new AbortController().signal)).toBe(false);
  });

  it("detect reads the live config and the managed model's log", () => {
    expect(build({ approved: true }).port.detect("local-llama")).toEqual({ contextWindow: 262_144 });
  });
});
