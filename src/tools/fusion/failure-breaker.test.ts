import { describe, expect, it } from "vitest";

import {
  FanoutFailureBreaker,
  REPEAT_FAILURE_STREAK,
  classifyWorkerFailure,
  describeTrip,
  normaliseError,
  refusalFromTrips,
  type BreakerTrip,
} from "./failure-breaker.js";

const failed = (error: string) => ({ status: "failed" as const, error });
const ok = { status: "ok" as const };

describe("classifyWorkerFailure (ATO-1406)", () => {
  it.each([
    ["invalid tool-call JSON: Unexpected token } in JSON at position 41", "blocker:tool-protocol"],
    ["tool-call args must be a JSON object", "blocker:tool-protocol"],
    ['tool call "os.fs.write" arguments are not a valid JSON object', "blocker:tool-protocol"],
    ["400: tools are not supported by this model", "blocker:tool-protocol"],
    ["workers hit a tool/protocol mismatch", "blocker:tool-protocol"],
    ["Codex isn't installed (the `codex` command was not found). Install it", "blocker:cli-missing"],
    ['"codex" is not signed in. Run codex login', "blocker:not-signed-in"],
    ["401 Unauthorized", "blocker:not-signed-in"],
    ['"openrouter" is out of credit after 3 steps', "blocker:out-of-credit"],
    ["You have hit your usage limit, try again later", "blocker:out-of-credit"],
  ])("files %j as a blocker", (error, signature) => {
    const c = classifyWorkerFailure(failed(error));
    expect(c?.blocker).toBe(true);
    expect(c?.signature).toBe(signature);
  });

  it("files any other failure as a repeat keyed on its normalised text", () => {
    const a = classifyWorkerFailure(failed("worker died after 12 steps on /repo/src/a.ts"));
    const b = classifyWorkerFailure(failed("worker died after 40 steps on /repo/lib/b.ts"));
    expect(a?.blocker).toBe(false);
    expect(a?.signature).toBe(b?.signature);
  });

  it("does not file a bare 429 as a blocker: a rate limit can pass in seconds", () => {
    expect(classifyWorkerFailure(failed("429 Too Many Requests"))?.blocker).toBe(false);
  });

  it("ignores rows that are not failures, and rows a cap kept from starting", () => {
    expect(classifyWorkerFailure(ok)).toBeUndefined();
    expect(classifyWorkerFailure({ status: "timeout", error: "x" })).toBeUndefined();
    expect(classifyWorkerFailure(failed("not started: cap"))).toBeUndefined();
    expect(classifyWorkerFailure(failed(""))).toBeUndefined();
  });
});

describe("normaliseError", () => {
  it("drops numbers, quotes, paths and hex", () => {
    expect(normaliseError('step 3: "abc" at /a/b/c.ts id deadbeef00')).toBe(
      normaliseError("step 9: \"xyz\" at /q/r.ts id 0123456789abcdef"),
    );
  });
});

describe("FanoutFailureBreaker", () => {
  it("trips on the first blocker", () => {
    const b = new FanoutFailureBreaker("codex");
    b.observe(failed("invalid tool-call JSON: oops"));
    expect(b.tripped()).toMatchObject({ blocker: true, providerId: "codex" });
    expect(b.stopReason()).toContain("tool-call protocol");
  });

  it(`trips after ${REPEAT_FAILURE_STREAK} identical failures in a row`, () => {
    const b = new FanoutFailureBreaker("cloud");
    for (let i = 1; i < REPEAT_FAILURE_STREAK; i += 1) {
      b.observe(failed(`worker died after ${i} steps`));
      expect(b.tripped()).toBeUndefined();
    }
    b.observe(failed("worker died after 99 steps"));
    expect(b.tripped()).toMatchObject({ blocker: false, count: REPEAT_FAILURE_STREAK });
  });

  it("a success or a different error resets the streak", () => {
    const b = new FanoutFailureBreaker("cloud");
    b.observe(failed("worker died"));
    b.observe(failed("worker died"));
    b.observe(ok);
    b.observe(failed("worker died"));
    b.observe(failed("something else broke"));
    b.observe(failed("worker died"));
    expect(b.tripped()).toBeUndefined();
  });

  it("does not count rows that are not failures", () => {
    const b = new FanoutFailureBreaker("cloud");
    b.observe(failed("worker died"));
    b.observe({ status: "timeout", error: "time limit" });
    b.observe(failed("worker died"));
    b.observe(failed("worker died"));
    expect(b.tripped()).toBeDefined();
  });
});

describe("refusalFromTrips", () => {
  const trip = (over: Partial<BreakerTrip>): BreakerTrip => ({
    signature: "repeat:x",
    blocker: false,
    label: "x",
    count: 3,
    providerId: "cloud",
    ...over,
  });

  it("refuses the same leg after a blocker, not another leg", () => {
    const trips = [trip({ blocker: true, signature: "blocker:tool-protocol", providerId: "codex" })];
    expect(refusalFromTrips(trips, "codex")).toBeDefined();
    expect(refusalFromTrips(trips, "local-llama")).toBeUndefined();
  });

  it("refuses after the same repeat stopped two rounds, not one", () => {
    expect(refusalFromTrips([trip({})], "cloud")).toBeUndefined();
    expect(refusalFromTrips([trip({}), trip({ signature: "repeat:y" })], "cloud")).toBeUndefined();
    expect(refusalFromTrips([trip({}), trip({})], "cloud")).toBeDefined();
  });

  it("words a trip plainly", () => {
    expect(describeTrip(trip({}))).toContain("3 workers in a row failed with the same error");
  });
});
