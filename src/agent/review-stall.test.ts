import { describe, expect, it } from "vitest";

import type { CompressedToolResult } from "../compressor/result-compressor.js";
import {
  REVIEW_STALL_CUT_REASON,
  REVIEW_STALL_TOOL_NAMES,
  createReviewStallState,
  formatReviewStallNotice,
  looksLikeRepairRequest,
  observeReviewStep,
  resolveReviewStallThreshold,
  reviewStallSignal,
  reviewStallToolSet,
  takeReviewStallNotice,
  type ReviewStallState,
} from "./review-stall.js";

const MUTATING = new Set(["os.fs.write", "os.shell.run", "fusion.delegate"]);
const mutates = (tool: string): boolean => MUTATING.has(tool);

function ok(tool: string): CompressedToolResult {
  return { tool, status: "ok", summary: tool, details: {}, truncated: false };
}

function refused(tool: string, details: Record<string, unknown>): CompressedToolResult {
  return { tool, status: "error", summary: "refused", details, truncated: false };
}

/** `n` consecutive read-only steps folded into `state`. */
function readSteps(state: ReviewStallState, n: number): ReviewStallState {
  let next = state;
  for (let i = 0; i < n; i += 1) {
    next = observeReviewStep(next, { results: [ok("os.fs.read")], mutates });
  }
  return next;
}

describe("review-stall — the count", () => {
  it("increments on read-only steps, batched reads included, and resets on a fan-out", () => {
    let state = createReviewStallState(6);
    state = readSteps(state, 2);
    state = observeReviewStep(state, {
      results: [ok("os.fs.read"), ok("os.fs.grep"), ok("verify.run")],
      mutates,
    });
    expect(state.readOnlySteps).toBe(3);
    state = observeReviewStep(state, {
      results: [ok("fusion.delegate")],
      mutates,
    });
    expect(state.readOnlySteps).toBe(0);
  });

  it("counts a refused write as a read-only step — it changed nothing", () => {
    let state = createReviewStallState(6);
    state = observeReviewStep(state, {
      results: [refused("os.fs.write", { fusion_orchestrator: true })],
      mutates,
    });
    state = observeReviewStep(state, {
      results: [refused("os.shell.run", { deniedReason: "tool-loop" })],
      mutates,
    });
    state = observeReviewStep(state, {
      results: [refused("os.fs.read", { tool_set: true })],
      mutates,
    });
    expect(state.readOnlySteps).toBe(3);
  });

  it("a refused fusion.delegate is not a fan-out", () => {
    let state = readSteps(createReviewStallState(6), 4);
    state = observeReviewStep(state, {
      results: [refused("fusion.delegate", { deniedReason: "tool-loop" })],
      mutates,
    });
    expect(state.readOnlySteps).toBe(5);
  });

  it("a mutation that actually ran breaks the run like a fan-out does", () => {
    let state = readSteps(createReviewStallState(6), 4);
    state = observeReviewStep(state, { results: [ok("os.fs.write")], mutates });
    expect(state.readOnlySteps).toBe(0);
  });

  it("a progress note (a kept reply) is a step of reading", () => {
    let state = createReviewStallState(6);
    state = observeReviewStep(state, {
      results: [ok("os.fs.read"), { ...ok("reply"), details: { progressNote: true } }],
      mutates,
    });
    expect(state.readOnlySteps).toBe(1);
  });
});

describe("review-stall — the phases", () => {
  it("is silent below N, notices at N, cuts at 2N", () => {
    const n = 6;
    let state = createReviewStallState(n);
    for (let steps = 0; steps < 2 * n + 2; steps += 1) {
      const signal = reviewStallSignal(state);
      if (steps < n) expect(signal, `at ${steps}`).toBeNull();
      else if (steps < 2 * n)
        expect(signal, `at ${steps}`).toEqual({ steps, phase: "notice" });
      else expect(signal, `at ${steps}`).toEqual({ steps, phase: "cut" });
      state = readSteps(state, 1);
    }
  });

  it("gives the notice once per stall, the cut notice once per cut step, and re-arms after a fan-out", () => {
    let state = readSteps(createReviewStallState(2), 2);
    const first = takeReviewStallNotice(state, reviewStallSignal(state)!);
    expect(first.notice).toContain("2 steps of reading and no fan-out");
    state = first.state;
    // The same step retried, and the step after: nothing new.
    expect(takeReviewStallNotice(state, reviewStallSignal(state)!).notice).toBeNull();
    state = readSteps(state, 1);
    expect(takeReviewStallNotice(state, reviewStallSignal(state)!).notice).toBeNull();
    // The cut step says so, and says it again if the model reads anyway.
    state = readSteps(state, 1);
    const cut = takeReviewStallNotice(state, reviewStallSignal(state)!);
    expect(cut.notice).toContain("4 steps of reading and no fan-out");
    expect(cut.notice).toContain("This step runs only `fusion.delegate`, `reply` or `finish`");
    state = cut.state;
    expect(takeReviewStallNotice(state, reviewStallSignal(state)!).notice).toBeNull();
    state = readSteps(state, 1);
    expect(takeReviewStallNotice(state, reviewStallSignal(state)!).notice).toContain(
      "5 steps of reading",
    );
    // A fan-out resets everything: the next stall notices again.
    state = observeReviewStep(state, { results: [ok("fusion.delegate")], mutates });
    expect(reviewStallSignal(state)).toBeNull();
    state = readSteps(state, 2);
    expect(takeReviewStallNotice(state, reviewStallSignal(state)!).notice).not.toBeNull();
  });

  it("0 disables both the notice and the cut", () => {
    let state = createReviewStallState(0);
    state = readSteps(state, 40);
    expect(state.readOnlySteps).toBe(0);
    expect(reviewStallSignal(state)).toBeNull();
  });

  it("the notice text is the one the model reads", () => {
    expect(formatReviewStallNotice({ steps: 6, phase: "notice" })).toBe(
      "6 steps of reading and no fan-out. In Fusion you cannot edit; a fix means `fusion.delegate` with the change spelled out, or `reply` with what stands. Next step: delegate or reply.",
    );
    expect(formatReviewStallNotice({ steps: 12, phase: "cut" })).toBe(
      "12 steps of reading and no fan-out. In Fusion you cannot edit; a fix means `fusion.delegate` with the change spelled out, or `reply` with what stands. Next step: delegate or reply. This step runs only `fusion.delegate`, `reply` or `finish`; any other call is refused.",
    );
  });

  it("the cut step's tool set is the three names", () => {
    expect(REVIEW_STALL_TOOL_NAMES).toEqual(["fusion.delegate", "reply", "finish"]);
    expect(reviewStallToolSet()).toEqual({
      names: ["fusion.delegate", "reply", "finish"],
      reason: REVIEW_STALL_CUT_REASON,
    });
    expect(REVIEW_STALL_CUT_REASON).toBe("review stalled: delegate or reply");
  });
});

describe("review-stall — a repair request halves N", () => {
  it("recognises a checker's FAIL line and the two verbs as whole words", () => {
    expect(looksLikeRepairRequest("check 3: FAIL — expected 200")).toBe(true);
    expect(looksLikeRepairRequest("the build failed on main")).toBe(true);
    expect(looksLikeRepairRequest("two tests are Failing")).toBe(true);
    expect(looksLikeRepairRequest("add a failure page")).toBe(false);
    expect(looksLikeRepairRequest("unfailing service, fail-safe")).toBe(false);
    expect(looksLikeRepairRequest("a fail in the log")).toBe(false);
    expect(looksLikeRepairRequest("")).toBe(false);
    expect(looksLikeRepairRequest(null)).toBe(false);
  });

  it("halves rounded up, keeps 0 at 0 and 1 at 1", () => {
    expect(resolveReviewStallThreshold(6, "FAIL")).toBe(3);
    expect(resolveReviewStallThreshold(5, "it failed")).toBe(3);
    expect(resolveReviewStallThreshold(1, "failing")).toBe(1);
    expect(resolveReviewStallThreshold(0, "FAIL")).toBe(0);
    expect(resolveReviewStallThreshold(6, "build the site")).toBe(6);
    expect(resolveReviewStallThreshold(6)).toBe(6);
  });

  it("the halved N moves both phases", () => {
    let state = createReviewStallState(6, "check: FAIL");
    expect(state.threshold).toBe(3);
    state = readSteps(state, 3);
    expect(reviewStallSignal(state)).toEqual({ steps: 3, phase: "notice" });
    state = readSteps(state, 3);
    expect(reviewStallSignal(state)).toEqual({ steps: 6, phase: "cut" });
  });
});
