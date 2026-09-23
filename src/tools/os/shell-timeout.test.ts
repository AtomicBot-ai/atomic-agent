import { describe, expect, it } from "vitest";

import {
  describeShellTimeoutDefault,
  formatShellDetachNotice,
  formatShellDuration,
  formatShellElapsed,
  formatShellTimeoutNotice,
  resolveShellTimeout,
} from "./shell-timeout.js";

describe("resolveShellTimeout", () => {
  it("takes the configured default when timeoutMs is omitted", () => {
    expect(resolveShellTimeout(undefined, 600_000)).toEqual({
      timeoutMs: 600_000,
      source: "default",
    });
  });

  it("lets an explicit timeoutMs win over the default, 0 included", () => {
    expect(resolveShellTimeout(5_000, 600_000)).toEqual({
      timeoutMs: 5_000,
      source: "explicit",
    });
    expect(resolveShellTimeout(0, 600_000)).toEqual({
      timeoutMs: 0,
      source: "explicit",
    });
  });

  it("reads a negative explicit value as no limit", () => {
    expect(resolveShellTimeout(-1, 600_000)).toEqual({
      timeoutMs: 0,
      source: "explicit",
    });
  });

  it("treats a non-numeric timeoutMs as omitted", () => {
    for (const raw of [null, "5000", NaN, Infinity, true, {}]) {
      expect(resolveShellTimeout(raw, 600_000)).toEqual({
        timeoutMs: 600_000,
        source: "default",
      });
    }
  });

  it("a default of 0 is no limit", () => {
    expect(resolveShellTimeout(undefined, 0)).toEqual({
      timeoutMs: 0,
      source: "default",
    });
  });
});

describe("formatShellDuration", () => {
  it("uses minutes for whole minutes and seconds otherwise", () => {
    expect(formatShellDuration(600_000)).toBe("10 min");
    expect(formatShellDuration(60_000)).toBe("1 min");
    expect(formatShellDuration(90_000)).toBe("90 s");
    expect(formatShellDuration(5_000)).toBe("5 s");
    expect(formatShellDuration(1_500)).toBe("1.5 s");
    expect(formatShellDuration(300)).toBe("0.3 s");
  });
});

describe("formatShellElapsed", () => {
  it("rounds to the unit a person would say", () => {
    expect(formatShellElapsed(12_345)).toBe("12 s");
    expect(formatShellElapsed(754_321)).toBe("13 min");
    expect(formatShellElapsed(3_600_000)).toBe("1 h");
    expect(formatShellElapsed(4_000_000)).toBe("1 h 7 min");
  });
});

describe("formatShellTimeoutNotice", () => {
  it("names the model's own timeoutMs and what to pass", () => {
    expect(
      formatShellTimeoutNotice({ timeoutMs: 5_000, source: "explicit" }),
    ).toBe(
      "stopped after 5 s (timeoutMs) — output so far below; pass a larger timeoutMs for a longer run, or 0 for no limit",
    );
  });
});

describe("formatShellDetachNotice", () => {
  it("names the job and the three forms on the first detach", () => {
    expect(
      formatShellDetachNotice({
        jobId: 3,
        waitedMs: 600_000,
        again: false,
        defaultTimeoutMs: 600_000,
      }),
    ).toBe(
      'still running after 10 min (job 3) — output so far below; os.shell.run {"wait": 3} keeps waiting (up to another 10 min per call), {"kill": 3} stops it, pass timeoutMs for a longer first wait',
    );
  });

  it("says 'another' when a wait elapsed, and drops the per-call cap when there is none", () => {
    expect(
      formatShellDetachNotice({
        jobId: 3,
        waitedMs: 30_000,
        again: true,
        defaultTimeoutMs: 0,
      }),
    ).toBe(
      'still running after another 30 s (job 3) — output so far below; os.shell.run {"wait": 3} keeps waiting, {"kill": 3} stops it, pass timeoutMs with the wait for a longer one',
    );
  });
});

describe("describeShellTimeoutDefault", () => {
  it("states the default, that it detaches rather than kills, and the forms", () => {
    const text = describeShellTimeoutDefault(600_000);
    expect(text).toContain("default 10 min");
    expect(text).toContain("not killed but detached as a job");
    for (const form of ['{"wait": id}', '{"kill": id}', '{"jobs": true}', "keep: true"]) {
      expect(text).toContain(form);
    }
    expect(text).toContain("Pass `timeoutMs` to stop the command at an explicit limit instead, `0` for none.");
  });

  it("says there is no timeout when the default is 0", () => {
    expect(describeShellTimeoutDefault(0)).toContain("no timeout");
  });
});
