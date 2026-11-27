import { describe, expect, it } from "vitest";

import { createEmptySessionState, type SessionState } from "../session/index.js";
import { forkUsage, parseForkPoint, planChannelFork } from "./channel-fork.js";

function session(questions: string[]): SessionState {
  const state = createEmptySessionState({ id: "s-src", workingDir: "/tmp/test" });
  state.turns = questions.flatMap((text, i) => [
    { kind: "user" as const, text, at: i * 2 + 1 },
    { kind: "assistant_reply" as const, text: `answer ${i + 1}`, at: i * 2 + 2 },
  ]);
  state.turnCount = questions.length;
  state.macroTurnStarts = questions.map((_, i) => i * 2 + 2);
  return state;
}

function runtime(source: SessionState) {
  return {
    sessionStore: { load: (id: string) => (id === source.id ? source : null) },
    turnController: { isBusy: () => false },
  } as never;
}

describe("parseForkPoint (ATO-2456)", () => {
  it("takes the last question when no number is given", () => {
    expect(parseForkPoint(undefined, 3)).toBe(3);
    expect(parseForkPoint("  ", 3)).toBe(3);
  });

  it("accepts 1..questions and nothing else", () => {
    expect(parseForkPoint("1", 3)).toBe(1);
    expect(parseForkPoint("3", 3)).toBe(3);
    expect(parseForkPoint("0", 3)).toBeNull();
    expect(parseForkPoint("4", 3)).toBeNull();
    expect(parseForkPoint("-1", 3)).toBeNull();
    expect(parseForkPoint("two", 3)).toBeNull();
  });
});

describe("planChannelFork with a point", () => {
  it("keeps question n and its answer, nothing after", () => {
    const source = session(["first", "second", "third"]);
    const plan = planChannelFork(runtime(source), source.id, { at: "2" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.state.turns.map((t) => (t.kind === "user" || t.kind === "assistant_reply" ? t.text : ""))).toEqual([
      "first",
      "answer 1",
      "second",
      "answer 2",
    ]);
  });

  it("answers a bad number with the range and the questions, in this channel's spelling", () => {
    const source = session(["first", "second"]);
    const plan = planChannelFork(runtime(source), source.id, { at: "9", command: "!fork" });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.message).toContain("!fork 1");
    expect(plan.message).toContain("1. first");
    expect(plan.message).toContain("2. second");
  });
});

describe("forkUsage", () => {
  it("lists only the latest ten, keeps their real numbers and drops the sender line", () => {
    const questions = Array.from({ length: 12 }, (_, i) => `[from] name="Ada" platform=discord\nquestion ${i + 1}`);
    const text = forkUsage(session(questions), 12, "/fork");
    expect(text).toContain("Latest questions:");
    const lines = text.split("\n");
    expect(lines).not.toContain("1. question 1");
    expect(lines).not.toContain("2. question 2");
    expect(lines).toContain("3. question 3");
    expect(text).toContain("12. question 12");
    expect(text).not.toContain("[from]");
  });
});
