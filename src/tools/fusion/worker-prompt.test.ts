import { describe, expect, it } from "vitest";

import {
  assistantReplyTurn,
  userTurn,
} from "../../session/conversation-turn.js";
import { parseDelegateArgs } from "./delegate-args.js";
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

  it("labels a task that named no title with its humanised id", () => {
    const parsed = parseDelegateArgs({
      tasks: [{ id: "fix_main_sync", instructions: "Fix it." }],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const brief = renderWorkerBrief(parsed.tasks[0]!, { workingDir: "/repo" });
    expect(brief).toContain("TASK fix_main_sync: fix main sync");
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

describe("renderWorkerBrief — the contract", () => {
  const CONTRACT = {
    owners: { "js/ship.js": "t1", "index.html": "html" },
    provides: [
      { task: "t1", kind: "symbol" as const, name: "HD.Ship", in: "js/ship.js" },
      { task: "html", kind: "id" as const, name: "btn-launch", in: "index.html" },
    ],
    requires: [{ task: "t1", name: "btn-launch" }],
  };

  it("prepends the shared block and this task's three lines, between the request and the TASK", () => {
    const brief = renderWorkerBrief(TASK, {
      workingDir: "/repo",
      originalRequest: "Build the game",
      contract: CONTRACT,
    });
    const requestEnd = brief.indexOf("----- END ORIGINAL REQUEST -----");
    const contractAt = brief.indexOf("CONTRACT — the interface between the parts");
    const forTaskAt = brief.indexOf("For TASK t1:");
    const taskAt = brief.indexOf("TASK t1: Map the auth routes");
    expect(requestEnd).toBeGreaterThan(0);
    expect(contractAt).toBeGreaterThan(requestEnd);
    expect(forTaskAt).toBeGreaterThan(contractAt);
    expect(taskAt).toBeGreaterThan(forTaskAt);
    // The whole contract, then what it means for this worker.
    expect(brief).toContain("- [html] id btn-launch in index.html");
    expect(brief).toContain("You own: js/ship.js");
    expect(brief).toContain("You provide: symbol HD.Ship in js/ship.js");
    expect(brief).toContain("You may rely on: btn-launch (id from html in index.html)");
    // The frame line is still first.
    expect(brief.split("\n")[0]).toContain("You are a worker agent");
  });

  it("tells every worker what the contract declares but nothing can honour", () => {
    // A require nothing provides and a provide nothing can check used
    // to refuse the call; now they are notes at the end of the block a
    // worker reads, so it neither waits for the one nor is judged on
    // the other.
    const parsed = parseDelegateArgs({
      tasks: [
        { id: "t1", instructions: "x" },
        { id: "organize", instructions: "y" },
      ],
      contract: {
        provides: [
          { task: "t1", kind: "file", name: "manifest.json" },
          { task: "organize", kind: "other", name: "done" },
        ],
        requires: [{ task: "t1", name: "organized_files" }],
      },
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const brief = renderWorkerBrief(parsed.tasks[0]!, {
      workingDir: "/repo",
      contract: parsed.contract,
    });
    const provideNote =
      'contract: provides "done" (task organize) cannot be checked: no `in`, no owned path, no declared files';
    const requireNote =
      'contract: requires "organized_files" (task t1) has no provider — nothing produces it';
    expect(brief).toContain(provideNote);
    expect(brief).toContain(requireNote);
    expect(brief).toContain("- [organize] other done");
    expect(brief).toContain("You may rely on: nothing from the other parts");
    // Inside the CONTRACT block, ahead of this task's own three lines.
    expect(brief.indexOf(provideNote)).toBeGreaterThan(
      brief.indexOf("CONTRACT — the interface between the parts"),
    );
    expect(brief.indexOf(requireNote)).toBeLessThan(brief.indexOf("For TASK t1:"));
  });

  it("adds the PROVIDED rule only when there is a contract", () => {
    const withContract = renderWorkerBrief(TASK, { workingDir: "/repo", contract: CONTRACT });
    expect(withContract).toMatch(/- End the reply with a `PROVIDED:` list/);
    const without = renderWorkerBrief(TASK, { workingDir: "/repo" });
    expect(without).not.toContain("PROVIDED:");
    expect(without).not.toContain("CONTRACT");
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

describe("renderWorkerBrief — declared inputs (F51)", () => {
  it("lists the contract's inputs in the shared block, ahead of this task's own lines", () => {
    const brief = renderWorkerBrief(TASK, {
      workingDir: "/repo",
      contract: { inputs: ["sales.csv"], owners: { "report.md": "t1" } },
    });
    const inputsAt = brief.indexOf(
      "INPUTS (the operator's own files — read and edit in place, never replace; os.fs.write on one is refused):\n- sales.csv",
    );
    expect(inputsAt).toBeGreaterThan(
      brief.indexOf("CONTRACT — the interface between the parts"),
    );
    expect(inputsAt).toBeLessThan(brief.indexOf("For TASK t1:"));
    expect(brief).toContain("You own: report.md");
  });
});
