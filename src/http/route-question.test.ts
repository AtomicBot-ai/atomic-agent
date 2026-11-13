import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApprovalDecision } from "../approval/approval-gate.js";
import type { UserQuestion } from "../approval/user-question.js";

import { startTestHarness, type Harness } from "./test-harness.js";

const QUESTION: UserQuestion = {
  prompt: "Which database?",
  options: [{ label: "SQLite" }, { label: "Postgres" }],
  multiSelect: false,
  allowOther: true,
};

describe("POST /api/question/answer (ATO-489)", () => {
  let harness: Harness;
  let pending: Promise<ApprovalDecision>;

  beforeEach(async () => {
    // Level 5: a question still waits for a person.
    harness = await startTestHarness({ approvalLevel: 5 });
    pending = harness.runtime.approvals.request({
      approvalId: "q-1",
      sessionId: "s-test",
      tool: "ask_user",
      category: "user_question",
      reason: QUESTION.prompt,
      question: QUESTION,
    });
  });

  afterEach(async () => {
    harness.runtime.approvals.resolve({ approvalId: "q-1", approved: false, automatic: true });
    await harness.cleanup();
  });

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${harness.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("publishes the question on the approval bus with its options", () => {
    const published = harness.approvalBus.snapshot().find((r) => r.approvalId === "q-1");
    expect(published?.category).toBe("user_question");
    expect(published?.question).toEqual(QUESTION);
  });

  it("resolves the question with the picked option", async () => {
    const response = await post("/api/question/answer", { approvalId: "q-1", selected: [1] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resolved: true, answer: { selected: ["Postgres"] } });
    const decision = await pending;
    expect(decision.approved).toBe(true);
    expect(decision.answer).toEqual({ selected: ["Postgres"] });
  });

  it("takes the person's own words", async () => {
    const response = await post("/api/question/answer", { approvalId: "q-1", other: "DuckDB" });
    expect(response.status).toBe(200);
    expect((await pending).answer).toEqual({ selected: [], other: "DuckDB" });
  });

  it("keeps the question open on an answer it does not take", async () => {
    const response = await post("/api/question/answer", { approvalId: "q-1", selected: [0, 1] });
    expect(response.status).toBe(400);
    expect(harness.runtime.approvals.isPending("q-1")).toBe(true);
  });

  it("skips it", async () => {
    const response = await post("/api/question/answer", { approvalId: "q-1", skip: true });
    expect(response.status).toBe(200);
    expect((await pending).approved).toBe(false);
  });

  it("refuses a bare approve of a question on the approval route", async () => {
    const response = await post("/api/approval/resolve", { approvalId: "q-1", decision: "allow-once" });
    expect(response.status).toBe(400);
    expect(harness.runtime.approvals.isPending("q-1")).toBe(true);
  });

  it("is 404 for an id that is not pending", async () => {
    const response = await post("/api/question/answer", { approvalId: "ghost", selected: [0] });
    expect(response.status).toBe(404);
  });
});
