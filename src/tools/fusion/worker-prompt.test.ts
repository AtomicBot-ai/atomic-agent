import { describe, expect, it } from "vitest";

import {
  assistantReplyTurn,
  userTurn,
} from "../../session/conversation-turn.js";
import {
  FOLLOW_UP_MAX_CHARS,
  ORIGINAL_REQUEST_CHAR_BUDGET,
  pickOriginalRequest,
  renderWorkerBrief,
} from "./worker-prompt.js";
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
    expect(brief).toMatch(/exactly what was blocked and where/);
  });

  it("says the reply is the whole handover, and bounds it", () => {
    const brief = renderWorkerBrief(TASK, { workingDir: "/repo" });
    expect(brief).toContain("`reply`");
    expect(brief).toMatch(/ONLY thing the orchestrator receives/);
    expect(brief).toContain("4000 characters");
  });
});

describe("renderWorkerBrief — the original request", () => {
  const REQUEST =
    "Build a browser snake game: index.html, style.css, js/main.js; dark theme, arrow keys.";

  it("quotes the operator's request, labelled as context, ABOVE the task", () => {
    // A worker briefed only "write index.html and style.css" built a
    // landing page, not the game: the request is what its part must match.
    const brief = renderWorkerBrief(TASK, {
      workingDir: "/repo",
      originalRequest: REQUEST,
    });
    expect(brief).toContain(
      "ORIGINAL REQUEST — context only; your task is below.",
    );
    expect(brief).toContain(REQUEST);
    const requestAt = brief.indexOf("----- BEGIN ORIGINAL REQUEST -----");
    const endAt = brief.indexOf("----- END ORIGINAL REQUEST -----");
    const taskAt = brief.indexOf("TASK t1: Map the auth routes");
    expect(requestAt).toBeGreaterThan(0);
    expect(requestAt).toBeLessThan(brief.indexOf(REQUEST));
    expect(endAt).toBeGreaterThan(brief.indexOf(REQUEST));
    expect(taskAt).toBeGreaterThan(endAt);
    // The frame line and the task body are unchanged.
    expect(brief.split("\n")[0]).toContain("You are a worker agent");
    expect(brief).toContain(TASK.instructions);
  });

  it("omits the section entirely when there is no request (or only whitespace)", () => {
    for (const originalRequest of [undefined, "", "   \n"]) {
      const brief = renderWorkerBrief(TASK, {
        workingDir: "/repo",
        ...(originalRequest === undefined ? {} : { originalRequest }),
      });
      expect(brief).not.toContain("ORIGINAL REQUEST");
      expect(brief).toBe(renderWorkerBrief(TASK, { workingDir: "/repo" }));
    }
  });

  it("clips a huge request at the budget and says so explicitly", () => {
    const huge = "a".repeat(ORIGINAL_REQUEST_CHAR_BUDGET) + "TAIL-MARKER";
    const brief = renderWorkerBrief(TASK, {
      workingDir: "/repo",
      originalRequest: huge,
    });
    expect(brief).not.toContain("TAIL-MARKER");
    expect(brief).toContain(
      `(truncated: the original request is ${huge.length.toLocaleString("en-US")} chars; only the first ${ORIGINAL_REQUEST_CHAR_BUDGET.toLocaleString("en-US")} are quoted above.)`,
    );
  });
});

describe("pickOriginalRequest", () => {
  const LONG = "Build the thing. ".repeat(30);

  it("uses the message that started the turn when it is a real request", () => {
    expect(
      pickOriginalRequest({
        current: LONG,
        earlierTurns: [userTurn("an older, unrelated ask")],
      }),
    ).toBe(LONG.trim());
  });

  it("quotes the previous request along with a short follow-up", () => {
    // "continue" alone tells a worker nothing about what is continued.
    const picked = pickOriginalRequest({
      current: "continue",
      earlierTurns: [
        userTurn(LONG),
        assistantReplyTurn("ran out of steps, say continue"),
      ],
    });
    expect("continue".length).toBeLessThan(FOLLOW_UP_MAX_CHARS);
    expect(picked).toContain(LONG.trim());
    expect(picked).toContain(
      "[the operator's latest message, which started this turn]\ncontinue",
    );
    expect(picked!.indexOf(LONG.trim())).toBeLessThan(
      picked!.indexOf("continue"),
    );
  });

  it("falls back to the last user message when the turn carried none", () => {
    expect(
      pickOriginalRequest({
        current: "  ",
        earlierTurns: [userTurn("first"), userTurn("second")],
      }),
    ).toBe("second");
  });

  it("returns the short message alone when nothing came before it, and nothing when there is nothing", () => {
    expect(pickOriginalRequest({ current: "hi", earlierTurns: [] })).toBe("hi");
    expect(
      pickOriginalRequest({
        current: "",
        earlierTurns: [assistantReplyTurn("only the assistant spoke")],
      }),
    ).toBeUndefined();
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
