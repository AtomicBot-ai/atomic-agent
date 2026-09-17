import { describe, expect, it } from "vitest";

import {
  type CheckSubject,
  evaluateCheck,
  evaluateChecks,
  tokenizeCheck,
} from "./verify-checks.js";

const COMMAND: CheckSubject = {
  kind: "command",
  exitCode: 1,
  stdout: "12 passed\n2 failed\n",
  stderr: "",
};

const PAGE: CheckSubject = {
  kind: "page",
  errors: [],
  consoleErrors: ["TypeError: x is null"],
  missingSelectors: ["# launch-btn"],
  probes: {
    lives: [[0, 3], [250, 3], [500, 2], [750, 1]],
    score: [[0, 0], [250, 10], [500, 20]],
    state: [[0, "menu"], [250, "menu"], [500, "playing"]],
  },
};

describe("tokenizeCheck", () => {
  it("keeps quoted strings whole and unescapes them", () => {
    expect(tokenizeCheck('stdout contains "all tests passed"')).toEqual([
      "stdout",
      "contains",
      "all tests passed",
    ]);
    expect(tokenizeCheck("stderr not contains 'a \\'b\\' c'")).toEqual([
      "stderr",
      "not",
      "contains",
      "a 'b' c",
    ]);
  });
});

describe("evaluateCheck", () => {
  it("exit: equality and inequality, with the actual code in the detail", () => {
    expect(evaluateCheck("exit 0", COMMAND)).toMatchObject({ ok: false, detail: "exit 1" });
    expect(evaluateCheck("exit != 0", COMMAND)).toMatchObject({ ok: true });
    expect(evaluateCheck("exit == 1", COMMAND)).toMatchObject({ ok: true });
    expect(evaluateCheck("exit 0", { kind: "command", exitCode: null, timedOut: true })).toMatchObject({
      ok: false,
      detail: "killed (timed out)",
    });
    expect(evaluateCheck("exit 0", PAGE).ok).toBe(false);
  });

  it("stdout / stderr contains, negated or not, over the full output", () => {
    expect(evaluateCheck('stdout contains "12 passed"', COMMAND).ok).toBe(true);
    expect(evaluateCheck('stdout not contains "failed"', COMMAND).ok).toBe(false);
    expect(evaluateCheck('stderr not contains "Error"', COMMAND).ok).toBe(true);
    expect(evaluateCheck("stdout contains", COMMAND).detail).toContain("unknown check");
  });

  it("status: every request must answer with the code", () => {
    const service: CheckSubject = { kind: "service", requests: [{ status: 200 }, { status: 200 }] };
    expect(evaluateCheck("status 200", service).ok).toBe(true);
    expect(evaluateCheck("status 200", { kind: "service", requests: [{ status: 200 }, { status: 500 }] })).toMatchObject({
      ok: false,
      detail: "statuses: 200, 500",
    });
    expect(evaluateCheck("status 200", { kind: "service", requests: [] }).detail).toBe("no requests were made");
  });

  it("no errors and missing selectors are page checks", () => {
    expect(evaluateCheck("no errors", PAGE)).toMatchObject({
      ok: false,
      detail: "0 uncaught error(s), 1 console error(s)",
    });
    expect(evaluateCheck("no errors", { ...PAGE, consoleErrors: [] }).ok).toBe(true);
    expect(evaluateCheck("no errors", COMMAND).ok).toBe(false);
    expect(evaluateCheck("missing selectors 0", PAGE)).toMatchObject({ ok: false });
    expect(evaluateCheck("missing selectors 1", PAGE).ok).toBe(true);
    expect(evaluateCheck("missing selectors 0", COMMAND).ok).toBe(false);
  });

  it("probe trends and values", () => {
    expect(evaluateCheck("probe lives decreases", PAGE)).toMatchObject({ ok: true, detail: "lives: 3 → 1 over 4 samples" });
    expect(evaluateCheck("probe lives increases", PAGE).ok).toBe(false);
    expect(evaluateCheck("probe score increases", PAGE).ok).toBe(true);
    expect(evaluateCheck("probe score equals 20", PAGE).ok).toBe(true);
    expect(evaluateCheck("probe score equals 10", PAGE).ok).toBe(false);
    expect(evaluateCheck("probe state reaches playing", PAGE).ok).toBe(true);
    expect(evaluateCheck('probe state reaches "over"', PAGE)).toMatchObject({ ok: false });
    expect(evaluateCheck("probe state stays menu", PAGE)).toMatchObject({ ok: false, detail: "state was playing at sample 2" });
    expect(evaluateCheck("probe lives stays 3", { ...PAGE, probes: { lives: [[0, 3], [250, 3]] } }).ok).toBe(true);
    expect(evaluateCheck("probe state decreases", PAGE)).toMatchObject({ ok: false });
    expect(evaluateCheck("probe nothing decreases", PAGE).detail).toBe('no probe named "nothing"');
  });

  it("fails unknown syntax rather than passing it", () => {
    for (const spec of ["passes", "exit", "probe", "no", "no errors please", "probe x between 1 2"]) {
      const out = evaluateCheck(spec, PAGE);
      expect(out.ok, spec).toBe(false);
      expect(out.detail, spec).toContain("unknown check");
    }
  });

  it("evaluateChecks keeps the order of the specs", () => {
    expect(evaluateChecks(["exit != 0", "exit 0"], COMMAND).map((c) => [c.check, c.ok])).toEqual([
      ["exit != 0", true],
      ["exit 0", false],
    ]);
  });
});
