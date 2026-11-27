import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ApprovalDecision } from "../approval/approval-gate.js";

import { startTestHarness, type Harness } from "./test-harness.js";

const VALUE = "correct horse 42!";

describe("POST /api/shell/secret (ATO-2486)", () => {
  let harness: Harness;
  let pending: Promise<ApprovalDecision>;

  beforeEach(async () => {
    // Level 5: a job's password still waits for a person.
    harness = await startTestHarness({ approvalLevel: 5 });
    pending = harness.runtime.approvals.request({
      approvalId: "sec-1",
      sessionId: "s-test",
      tool: "os.shell.run",
      category: "shell_secret",
      reason: "job 1 (sudo apt update) asks for sudo password",
      secretInput: { jobId: 1, label: "sudo password", commandLine: "sudo apt update", promptLine: "Password:" },
    });
  });

  afterEach(async () => {
    harness.runtime.approvals.resolve({ approvalId: "sec-1", approved: false, automatic: true });
    await harness.cleanup();
  });

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${harness.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("publishes the request with what to draw", () => {
    const published = harness.approvalBus.snapshot().find((r) => r.approvalId === "sec-1");
    expect(published?.category).toBe("shell_secret");
    expect(published?.secretInput).toMatchObject({ jobId: 1, label: "sudo password" });
  });

  it("hands the value to the tool and never echoes it", async () => {
    const response = await post("/api/shell/secret", { approvalId: "sec-1", value: VALUE });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(VALUE);
    expect(JSON.parse(text)).toMatchObject({ resolved: true, typed: true });
    const decision = await pending;
    expect(decision.approved).toBe(true);
    expect(decision.secret).toBe(VALUE);
  });

  it("keeps the request open on a value it cannot take", async () => {
    const response = await post("/api/shell/secret", { approvalId: "sec-1", value: "a\nb" });
    expect(response.status).toBe(400);
    expect(harness.runtime.approvals.isPending("sec-1")).toBe(true);
  });

  it("skips it", async () => {
    const response = await post("/api/shell/secret", { approvalId: "sec-1", skip: true });
    expect(response.status).toBe(200);
    expect((await pending).approved).toBe(false);
  });

  it("refuses a bare approve on the approval route", async () => {
    const response = await post("/api/approval/resolve", { approvalId: "sec-1", decision: "allow-once" });
    expect(response.status).toBe(400);
    expect(harness.runtime.approvals.isPending("sec-1")).toBe(true);
  });

  it("answers 404 once nothing is pending", async () => {
    const response = await post("/api/shell/secret", { approvalId: "gone", value: VALUE });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(VALUE);
  });
});
