import { describe, expect, it, vi } from "vitest";
import type { RunTurnResult } from "../../agent/agent-contract.js";
import { HookBlockedPromptError, MAX_STOP_HOOK_CONTINUATIONS, type TurnStopFacts } from "../../hooks/session-hook-engine.js";
import { assistantReplyTurn, userTurn } from "../../session/conversation-turn.js";
import { createEmptySessionState, type SessionState } from "../../session/session-state.js";
import { continueOnStopHooks, startTurnHooks } from "./runtime-session-hooks.js";

const session = (turns: SessionState["turns"] = []): SessionState => ({
  ...createEmptySessionState({ id: "s1", workingDir: "/work" }),
  turns,
});
const replied = (text: string, over: Partial<RunTurnResult> = {}): RunTurnResult => ({
  session: session([userTurn("go"), assistantReplyTurn(text)]),
  reason: "reply",
  stepCount: 2,
  ...over,
});

describe("startTurnHooks", () => {
  it("returns the session and turn hook texts apart and says whether the session is new", async () => {
    const beforeTurn = vi.fn(async () => ({ kind: "proceed" as const, sessionContext: "project: atomic", context: "on main" }));
    expect(await startTurnHooks({ beforeTurn }, session(), "fix it", undefined)).toEqual({ session: "project: atomic", turn: "on main" });
    expect(beforeTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1", cwd: "/work", prompt: "fix it", isNewSession: true }));
    await startTurnHooks({ beforeTurn }, session([userTurn("hi")]), "again", undefined);
    expect(beforeTurn).toHaveBeenLastCalledWith(expect.objectContaining({ isNewSession: false }));
  });

  it("a blocked prompt throws HookBlockedPromptError with the reason", async () => {
    const beforeTurn = async () => ({ kind: "blocked" as const, reason: "no secrets" });
    await expect(startTurnHooks({ beforeTurn }, session(), "my key is sk-1", undefined)).rejects.toBeInstanceOf(HookBlockedPromptError);
    await expect(startTurnHooks({ beforeTurn }, session(), "x", undefined)).rejects.toThrow("no secrets");
  });

  it("no engine: nothing runs", async () => {
    expect(await startTurnHooks(null, session(), "x", undefined)).toEqual({});
  });
});

describe("continueOnStopHooks", () => {
  it("a Stop block runs the agent again with the hook's reason, then lets it stop", async () => {
    const afterTurn = vi.fn<(facts: TurnStopFacts) => Promise<string | undefined>>()
      .mockResolvedValueOnce("tests are red")
      .mockResolvedValueOnce(undefined);
    const again = vi.fn(async () => replied("Fixed the tests.", { stepCount: 3, undelivered: ["late"] }));
    const out = await continueOnStopHooks({ afterTurn }, replied("Done."), undefined, again);
    expect(again).toHaveBeenCalledTimes(1);
    expect((again.mock.calls[0] as unknown[])[1]).toContain("tests are red");
    expect(afterTurn.mock.calls[0]![0]).toMatchObject({ stopHookActive: false, lastReply: "Done." });
    expect(afterTurn.mock.calls[1]![0]).toMatchObject({ stopHookActive: true, lastReply: "Fixed the tests." });
    expect(out.stepCount).toBe(5);
    expect(out.undelivered).toEqual(["late"]);
  });

  it("a hook that always blocks is capped", async () => {
    const afterTurn = vi.fn(async () => "never happy");
    const again = vi.fn(async () => replied("again"));
    await continueOnStopHooks({ afterTurn }, replied("Done."), undefined, again);
    expect(again).toHaveBeenCalledTimes(MAX_STOP_HOOK_CONTINUATIONS);
  });

  it("no Stop hook after a cancel, a failure or a ceiling stop; a block after finish is ignored", async () => {
    const afterTurn = vi.fn(async () => "more");
    const again = vi.fn(async () => replied("x"));
    for (const reason of ["cancelled", "failed", "max_steps"] as const) {
      await continueOnStopHooks({ afterTurn }, replied("x", { reason }), undefined, again);
    }
    await continueOnStopHooks({ afterTurn }, replied("x", { stopCause: "step_ceiling" }), undefined, again);
    expect(afterTurn).not.toHaveBeenCalled();
    const first = replied("bye", { reason: "finish" });
    expect(await continueOnStopHooks({ afterTurn }, first, undefined, again)).toBe(first);
    expect(afterTurn).toHaveBeenCalledTimes(1);
    expect(again).not.toHaveBeenCalled();
  });

  it("a cancelled turn signal stops the continuation", async () => {
    const ac = new AbortController();
    ac.abort();
    const afterTurn = vi.fn(async () => "more");
    const again = vi.fn(async () => replied("x"));
    await continueOnStopHooks({ afterTurn }, replied("Done."), ac.signal, again);
    expect(again).not.toHaveBeenCalled();
  });
});
