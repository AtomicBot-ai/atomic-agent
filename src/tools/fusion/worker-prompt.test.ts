import { describe, expect, it } from "vitest";

import { renderWorkerBrief } from "./worker-prompt.js";
import {
  FUSION_WORKER_APPROVAL_MARKER,
  FUSION_WORKER_APPROVAL_REFUSED,
} from "./worker-tool-policy.js";

const TASK = {
  id: "t1",
  title: "Map the auth routes",
  instructions: "List every route under src/http/ that touches auth.",
};

describe("renderWorkerBrief", () => {
  it("opens by naming the frame the worker is in", () => {
    // A worker session has no transcript, so an instruction that reads
    // like the middle of a conversation gets answered as if it were.
    const brief = renderWorkerBrief(TASK, { workingDir: "/repo" });
    expect(brief.split("\n")[0]).toBe(
      "You are a worker agent executing one delegated task inside /repo; you have no memory of the parent conversation.",
    );
  });

  it("carries the id, title and instructions verbatim", () => {
    const brief = renderWorkerBrief(TASK, { workingDir: "/repo" });
    expect(brief).toContain("TASK t1: Map the auth routes");
    expect(brief).toContain(TASK.instructions);
  });

  it("renders deliverable and files only when present", () => {
    const bare = renderWorkerBrief(TASK, { workingDir: "/repo" });
    expect(bare).not.toContain("DELIVERABLE:");
    expect(bare).not.toContain("FILES:");
    const full = renderWorkerBrief(
      { ...TASK, deliverable: "one bullet per route", files: ["a.ts", "b.ts"] },
      { workingDir: "/repo" },
    );
    expect(full).toContain("DELIVERABLE: one bullet per route");
    expect(full).toContain("- a.ts");
    expect(full).toContain("- b.ts");
  });

  it("forbids questions — nobody is on the other end of the session", () => {
    const brief = renderWorkerBrief(TASK, { workingDir: "/repo" });
    expect(brief).toMatch(/Never ask a question/);
    expect(brief).toMatch(/no user on this session/);
  });

  it("names the approval refusal so the model recognises the result", () => {
    const brief = renderWorkerBrief(TASK, { workingDir: "/repo" });
    expect(brief).toContain(FUSION_WORKER_APPROVAL_MARKER);
    expect(brief).toMatch(/exactly what must be run or written/);
  });

  it("says the reply is the whole handover, and bounds it", () => {
    const brief = renderWorkerBrief(TASK, { workingDir: "/repo" });
    expect(brief).toContain("`reply`");
    expect(brief).toMatch(/ONLY thing the orchestrator receives/);
    expect(brief).toContain("4000 characters");
  });
});

describe("the approval marker", () => {
  it("is a substring of the refusal the gate actually returns", () => {
    // Two consumers key off the marker (this brief, and the result
    // classifier). Both fail silently if the policy text drifts, so the
    // relationship is pinned rather than trusted.
    expect(FUSION_WORKER_APPROVAL_REFUSED).toContain(
      FUSION_WORKER_APPROVAL_MARKER,
    );
  });
});
