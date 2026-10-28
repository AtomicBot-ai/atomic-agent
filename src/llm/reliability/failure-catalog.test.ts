import { describe, expect, it } from "vitest";

import {
  FAILURE_CATALOG,
  failureVerdict,
  loopDetectorVerdict,
  type FailureAction,
  type FailureCauseId,
} from "./failure-catalog.js";

const ACTIONS: readonly FailureAction[] = [
  "retry",
  "switch-model",
  "new-chat-summary",
  "reduce-load",
  "add-search-key",
  "none",
];

const ids = Object.keys(FAILURE_CATALOG) as FailureCauseId[];

describe("FAILURE_CATALOG", () => {
  it("covers every cause the product owner listed (ATO-384)", () => {
    expect(ids).toEqual(
      expect.arrayContaining([
        "out_of_memory",
        "slow_local_model",
        "context_too_long",
        "rate_limited",
        "empty_response",
        "out_of_credit",
        "web_search_needs_key",
        "web_search_unavailable",
        "loop_detected",
        "same_call_repeated",
      ]),
    );
  });

  it.each(ids)("%s has a stable snake_case id, a plain phrase and a known action", (id) => {
    const entry = FAILURE_CATALOG[id];
    expect(id).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
    expect(ACTIONS).toContain(entry.action);
    // One plain sentence: no status codes, no config keys, no dashes.
    expect(entry.phrase).toMatch(/^[A-Z].*\.$/);
    expect(entry.phrase).not.toMatch(/\d/);
    expect(entry.phrase).not.toMatch(/[`_{}]|—/);
    expect(entry.phrase.length).toBeLessThanOrEqual(80);
  });

  it("maps the asked-for causes to the asked-for buttons", () => {
    expect(FAILURE_CATALOG.out_of_memory.action).toBe("reduce-load");
    expect(FAILURE_CATALOG.context_too_long.action).toBe("new-chat-summary");
    expect(FAILURE_CATALOG.rate_limited.action).toBe("retry");
    expect(FAILURE_CATALOG.empty_response.action).toBe("retry");
    expect(FAILURE_CATALOG.web_search_needs_key.action).toBe("add-search-key");
    expect(FAILURE_CATALOG.out_of_credit.action).toBe("switch-model");
  });

  it("a verdict is a fresh copy of its entry", () => {
    expect(failureVerdict("rate_limited")).toEqual({
      cause: "rate_limited",
      phrase: FAILURE_CATALOG.rate_limited.phrase,
      action: "retry",
    });
  });
});

describe("loopDetectorVerdict", () => {
  it("the exact same call repeated is its own cause", () => {
    expect(loopDetectorVerdict("generic_repeat").cause).toBe("same_call_repeated");
  });

  it.each(["no_progress", "wandering", "test_repeat", "read_repeat", "outcome_repeat", undefined] as const)(
    "%s is the agent going in circles",
    (detector) => {
      expect(loopDetectorVerdict(detector)).toMatchObject({ cause: "loop_detected", action: "switch-model" });
    },
  );
});
