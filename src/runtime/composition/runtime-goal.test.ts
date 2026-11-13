import { describe, expect, it, vi } from "vitest";

import type { RunTurnResult } from "../../agent/agent-contract.js";
import type { LlmStreamParams } from "../../agent/step/step-contract.js";
import { readGoalState, type GoalState } from "../../agent/goal/index.js";
import { getConfig, resetConfigCache } from "../../config/index.js";
import type { CompletionResult } from "../../llm/llama-server-client.js";
import { createEmptySessionState, type SessionState } from "../../session/index.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { createRuntimeGoalRunner, type GoalRoundRunner } from "./runtime-goal.js";

/** A store that serialises like the real one, so only JSON survives. */
function fakeStore() {
  const rows = new Map<string, string>();
  return {
    rows,
    load: (id: string): SessionState | null => {
      const row = rows.get(id);
      return row === undefined ? null : (JSON.parse(row) as SessionState);
    },
    save: (state: SessionState): void => { rows.set(state.id, JSON.stringify(state)); },
  };
}

function verdictResult(...marks: string[]): CompletionResult {
  return {
    content: JSON.stringify({ criteria: marks.map((m, i) => ({ index: i + 1, verdict: m, reason: "r" })) }),
  } as CompletionResult;
}

function setup(answers: CompletionResult[]) {
  const store = fakeStore();
  const llmComplete = vi.fn(async (_params: LlmStreamParams) => {
    const next = answers.shift();
    if (!next) throw new Error("no answer");
    return next;
  });
  const runner = createRuntimeGoalRunner({
    sessionStore: store,
    llmComplete,
    slotManager: { sideCallSlotId: () => -1 },
    resolveTransport: () => "grammar",
    logger: new StructuredLogger({ level: "error", sinks: [] }),
  });
  const messages: string[] = [];
  // Like `executeTurn`: re-read the stored session, answer, save.
  const runRound: GoalRoundRunner = async (session, message) => {
    messages.push(message);
    const base = store.load(session.id) ?? session;
    const next: SessionState = {
      ...base,
      turns: [...base.turns, { kind: "assistant_reply", text: `did round ${messages.length}`, at: 1 }],
    };
    store.save(next);
    return { session: next, reason: "reply", stepCount: 1 } satisfies RunTurnResult;
  };
  return { store, llmComplete, runner, messages, runRound };
}

describe("runtime goal runner", () => {
  it("stores the goal with the session so a restart can resume it", async () => {
    const t = setup([verdictResult("met", "not_met"), verdictResult("met", "not_met")]);
    const session = createEmptySessionState({ id: "s1", workingDir: process.cwd() });
    t.store.save(session);
    const result = await t.runner.run(session, "", { goal: { criteria: ["a", "b"], maxRounds: 2 } }, t.runRound);
    expect(result.goal?.status).toBe("budget_limited");

    // A new process: only what the store holds is left.
    const reloaded = readGoalState(t.store.load("s1")!.metadata);
    expect(reloaded).toMatchObject({ status: "budget_limited", roundsUsed: 2 });
    expect(reloaded?.criteria.map((c) => c.mark)).toEqual(["met", "not_met"]);
    expect(t.messages[0]).toContain("Acceptance list:");
  });

  it("resumes the stored goal with the same list instead of starting over", async () => {
    const t = setup([verdictResult("not_met"), verdictResult("met")]);
    const session = createEmptySessionState({ id: "s2", workingDir: process.cwd() });
    t.store.save(session);
    const first = await t.runner.run(session, "go", { goal: { criteria: ["a"], maxRounds: 1 } }, t.runRound);
    expect(first.goal?.status).toBe("budget_limited");

    const second = await t.runner.run(t.store.load("s2")!, "", { goal: { criteria: ["a"], maxRounds: 1 } }, t.runRound);
    expect(second.goal?.status).toBe("complete");
    // A resumed goal continues rather than kicking off again.
    expect(t.messages[1]).toContain("not done yet");
    expect(second.goal?.createdAt).toBe(first.goal?.createdAt);
  });

  it("starts a new goal with agent.goal.maxTokens, keeps a stored budget on resume (ATO-1036)", async () => {
    // The cached config object: set the key for this test only.
    getConfig().agent.goal = { maxTokens: 5000 };
    try {
      const t = setup([verdictResult("not_met"), verdictResult("met"), verdictResult("met")]);
      const session = createEmptySessionState({ id: "s-tokens", workingDir: process.cwd() });
      t.store.save(session);
      const first = await t.runner.run(session, "go", { goal: { criteria: ["a"], maxRounds: 1 } }, t.runRound);
      expect(first.goal?.maxTokens).toBe(5000);
      // A spec that names its own budget wins over the config default.
      const own = await t.runner.run(
        createEmptySessionState({ id: "s-own", workingDir: process.cwd() }),
        "go", { goal: { criteria: ["b"], maxTokens: 70 } }, t.runRound,
      );
      expect(own.goal?.maxTokens).toBe(70);

      getConfig().agent.goal = { maxTokens: 0 };
      // Resuming without a budget in the spec keeps the stored 5000.
      const resumed = await t.runner.run(t.store.load("s-tokens")!, "", { goal: { criteria: ["a"], maxRounds: 1 } }, t.runRound);
      expect(resumed.goal?.maxTokens).toBe(5000);
    } finally {
      resetConfigCache();
    }
  });

  it("starts a new goal uncapped when agent.goal.maxTokens is the default 0", async () => {
    resetConfigCache();
    expect(getConfig().agent.goal?.maxTokens ?? 0).toBe(0);
    const t = setup([verdictResult("met")]);
    const out = await t.runner.run(
      createEmptySessionState({ id: "s-nocap", workingDir: process.cwd() }),
      "go", { goal: { criteria: ["a"] } }, t.runRound,
    );
    expect(out.goal?.maxTokens).toBe(0);
  });

  it("asks the active model as the judge with a short side-call", async () => {
    const t = setup([verdictResult("met")]);
    const session = createEmptySessionState({ id: "s3", workingDir: process.cwd() });
    await t.runner.run(session, "go", { goal: { criteria: ["a"] } }, t.runRound);
    const params = t.llmComplete.mock.calls[0]![0];
    expect(params.sessionId).toBe("goal-judge:s3");
    expect(params.prompt).toContain("did round 1");
  });

  it("pauses a running goal after its round when asked", async () => {
    const t = setup([verdictResult("not_met"), verdictResult("not_met")]);
    const session = createEmptySessionState({ id: "s4", workingDir: process.cwd() });
    t.store.save(session);
    let goalSeen: GoalState | undefined;
    const runRound: GoalRoundRunner = async (s, m, ms) => {
      expect(t.runner.control("s4", "pause")).toBe(true);
      return t.runRound(s, m, ms);
    };
    const result = await t.runner.run(session, "go", {
      goal: { criteria: ["a"] },
      onGoalProgress: (g) => { goalSeen = g; },
    }, runRound);
    expect(t.messages).toHaveLength(1);
    expect(result.goal?.status).toBe("paused");
    expect(goalSeen?.status).toBe("paused");
    expect(t.runner.control("s4", "pause")).toBe(false);
  });

  it("refuses a second goal run on the same session", async () => {
    const t = setup([verdictResult("met")]);
    const session = createEmptySessionState({ id: "s5", workingDir: process.cwd() });
    let inner: Promise<unknown> | undefined;
    const runRound: GoalRoundRunner = async (s, m, ms) => {
      // Caught at once so the rejection is never unhandled meanwhile.
      inner = t.runner.run(s, "again", { goal: { criteria: ["a"] } }, t.runRound).catch((err: unknown) => err);
      return t.runRound(s, m, ms);
    };
    await t.runner.run(session, "go", { goal: { criteria: ["a"] } }, runRound);
    const err = await inner;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/already running/);
  });
});
