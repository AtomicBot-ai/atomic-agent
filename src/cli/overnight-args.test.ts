import { describe, expect, it } from "vitest";

import {
  OVERNIGHT_TASK_ID_FLAG,
  detachedChildArgs,
  parseOvernightArgs,
  type OvernightArgs,
} from "./overnight-args.js";

const env = {
  cwd: "/home/me/code",
  isDirectory: (path: string) => path.startsWith("/home/me"),
};

function parseOk(argv: string[]): OvernightArgs {
  const parsed = parseOvernightArgs(argv, env);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.args;
}

describe("parseOvernightArgs", () => {
  it("takes the task alone and fills in the defaults", () => {
    expect(parseOk(["tidy the repo"])).toEqual({
      task: "tidy the repo",
      budgetUsd: null,
      durationMs: 8 * 3_600_000,
      dir: "/home/me/code",
      notify: null,
      detach: false,
      noApproval: false,
      taskId: null,
    });
  });

  it("reads every flag, before or after the task, with or without =", () => {
    expect(
      parseOk([
        "--budget",
        "$5",
        "migrate",
        "--hours=1.5",
        "the tests",
        "--dir",
        "app",
        "--notify",
        "telegram",
        "--detach",
        "--no-approval",
      ]),
    ).toEqual({
      task: "migrate the tests",
      budgetUsd: 5,
      durationMs: 5_400_000,
      dir: "/home/me/code/app",
      notify: "telegram",
      detach: true,
      noApproval: true,
      taskId: null,
    });
  });

  it.each([
    [[], /missing the task/],
    [["x", "--budget", "0"], /--budget expects/],
    [["x", "--budget"], /--budget needs a value/],
    [["x", "--hours", "0"], /--hours expects/],
    [["x", "--hours", "8h"], /--hours expects/],
    [["x", "--hours", "500"], /--hours expects/],
    [["x", "--dir", "/etc"], /not a directory: \/etc/],
    [["x", "--notify", "email"], /only "telegram"/],
    [["x", "--frobnicate"], /unknown option: --frobnicate/],
  ])("refuses %j", (argv, error) => {
    const parsed = parseOvernightArgs(argv, env);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(error);
  });
});

describe("detachedChildArgs", () => {
  it("spells the run out again with an absolute dir, no --detach and the printed id", () => {
    const args = parseOk(["fix it", "--dir", "app", "--budget", "2.5", "--hours", "3", "--detach"]);
    const child = detachedChildArgs(args, "t-123");
    expect(child).toEqual([
      "overnight",
      "fix it",
      "--budget",
      "2.5",
      "--hours",
      "3",
      "--dir",
      "/home/me/code/app",
      OVERNIGHT_TASK_ID_FLAG,
      "t-123",
    ]);
    expect(child).not.toContain("--detach");
    // The child parses back to the same run.
    expect(parseOk(child.slice(1))).toEqual({ ...args, detach: false, taskId: "t-123" });
  });
});
