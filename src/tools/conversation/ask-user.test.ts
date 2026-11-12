import { describe, expect, it } from "vitest";

import { ApprovalGate, type ApprovalRequest } from "../../approval/approval-gate.js";
import type { ToolContext } from "../tool-registry.js";
import { buildAskUserTool, normalizeUserQuestion, USER_ANSWER_DETAIL } from "./ask-user.js";

function ctx(): ToolContext {
  return {
    workingDir: "/tmp",
    sessionId: "s-1",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

const ARGS = {
  question: "Which database should the app use?",
  options: [{ label: "SQLite", description: "one file" }, { label: "Postgres" }],
};

/** A real gate at full trust: a question must still reach a person. */
function setup(): { gate: ApprovalGate; asked: ApprovalRequest[] } {
  const asked: ApprovalRequest[] = [];
  const gate = new ApprovalGate({ emit: (r) => asked.push(r), level: 5 });
  return { gate, asked };
}

describe("ask_user (ATO-489)", () => {
  it("waits for the person even at approval level 5 and returns their pick", async () => {
    const { gate, asked } = setup();
    const tool = buildAskUserTool({ approvals: gate });
    const running = tool.run(ARGS, ctx());
    await Promise.resolve();
    expect(asked).toHaveLength(1);
    const request = asked[0]!;
    expect(request.category).toBe("user_question");
    expect(request.tool).toBe("ask_user");
    expect(request.reason).toBe(ARGS.question);
    expect(request.question?.options.map((o) => o.label)).toEqual(["SQLite", "Postgres"]);
    expect(request.question?.allowOther).toBe(true);
    expect(request.preview).toContain("1. SQLite - one file");
    gate.resolve({ approvalId: request.approvalId, approved: true, answer: { selected: ["Postgres"] } });
    const result = await running;
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("The user answered: Picked: Postgres.");
    expect(result.details[USER_ANSWER_DETAIL]).toEqual({ selected: ["Postgres"] });
  });

  it("passes the person's own words through", async () => {
    const { gate, asked } = setup();
    const running = buildAskUserTool({ approvals: gate }).run(ARGS, ctx());
    await Promise.resolve();
    gate.resolve({
      approvalId: asked[0]!.approvalId,
      approved: true,
      answer: { selected: [], other: "DuckDB" },
    });
    expect((await running).summary).toContain('Own answer: "DuckDB".');
  });

  it("never trusts an answer the question did not offer", async () => {
    const { gate, asked } = setup();
    const running = buildAskUserTool({ approvals: gate }).run(ARGS, ctx());
    await Promise.resolve();
    gate.resolve({ approvalId: asked[0]!.approvalId, approved: true, answer: { selected: ["Oracle"] } });
    const result = await running;
    expect(result.summary).toContain("closed without an answer");
    expect(result.details[USER_ANSWER_DETAIL]).toBeUndefined();
  });

  it("tells the model the user skipped on a deny", async () => {
    const { gate, asked } = setup();
    const running = buildAskUserTool({ approvals: gate }).run(ARGS, ctx());
    await Promise.resolve();
    gate.resolve({ approvalId: asked[0]!.approvalId, approved: false });
    expect((await running).summary).toContain("The user skipped this question");
  });

  it("does not park a session nobody watches", async () => {
    const { gate, asked } = setup();
    gate.setSessionPolicy("s-1", { onPrompt: "refuse", reason: "fusion worker" });
    const result = await buildAskUserTool({ approvals: gate }).run(ARGS, ctx());
    expect(asked).toHaveLength(0);
    expect(result.summary).toContain("Nobody can answer right now");
  });

  it("is not settled by a session grant: it still prompts after one is asked for", async () => {
    const { gate, asked } = setup();
    const first = buildAskUserTool({ approvals: gate }).run(ARGS, ctx());
    await Promise.resolve();
    // A host asking to remember the answer for the session records nothing.
    gate.resolve({
      approvalId: asked[0]!.approvalId,
      approved: true,
      grant: "category",
      answer: { selected: ["SQLite"] },
    });
    await first;
    expect(gate.wouldPrompt("s-1", "user_question", { tool: "ask_user" })).toBe(true);
  });
});

describe("normalizeUserQuestion", () => {
  it("trims, drops duplicate labels and defaults allowOther to true", () => {
    expect(
      normalizeUserQuestion({
        question: "  Pick a colour  ",
        options: ["red", { label: " red " }, { label: "blue", description: "  calm " }],
        multiSelect: true,
      }),
    ).toEqual({
      prompt: "Pick a colour",
      options: [{ label: "red" }, { label: "blue", description: "calm" }],
      multiSelect: true,
      allowOther: true,
    });
  });

  it("refuses fewer than two options or an empty question", () => {
    expect(() => normalizeUserQuestion({ question: "Q?", options: [{ label: "only" }] })).toThrow(
      /2 to 8 options/,
    );
    expect(() => normalizeUserQuestion({ question: " ", options: ["a", "b"] })).toThrow(/question/);
  });

  it("refuses more than eight options", () => {
    const options = Array.from({ length: 9 }, (_, i) => `option ${i}`);
    expect(() => normalizeUserQuestion({ question: "Q?", options })).toThrow(/got 9/);
  });
});
