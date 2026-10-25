import { describe, expect, it } from "vitest";

import { classifyShellCall } from "./shell-job-calls.js";

/**
 * ATO-891: some models fill every optional field of `os.shell.run` with
 * its zero value. Those defaults must not count as a second form, while
 * a real double form and real job ids keep working.
 */
describe("classifyShellCall", () => {
  it("treats zero-valued wait/kill/jobs next to cmd as absent (GPT-6 Astra shape)", () => {
    expect(
      classifyShellCall({
        cmd: "pwd; node -v",
        args: [],
        timeoutMs: 10000,
        keep: false,
        wait: 0,
        kill: 0,
        jobs: false,
      }),
    ).toEqual({ kind: "cmd" });
  });

  it("treats empty-string and stringified-zero fields as absent", () => {
    expect(classifyShellCall({ cmd: "ls", wait: "", kill: "  ", jobs: "" })).toEqual({
      kind: "cmd",
    });
    expect(classifyShellCall({ cmd: "ls", wait: "0", kill: "0" })).toEqual({ kind: "cmd" });
    expect(classifyShellCall({ cmd: "ls", wait: null, kill: undefined })).toEqual({
      kind: "cmd",
    });
  });

  it("keeps an empty cmd out of the way of a real job form", () => {
    expect(classifyShellCall({ cmd: "", wait: 3, kill: 0, jobs: false })).toEqual({
      kind: "wait",
      id: 3,
    });
    expect(classifyShellCall({ cmd: "", wait: 0, kill: 4 })).toEqual({ kind: "kill", id: 4 });
    expect(classifyShellCall({ cmd: "", wait: 0, kill: 0, jobs: true })).toEqual({
      kind: "jobs",
    });
  });

  it("still refuses a real double form", () => {
    const both = classifyShellCall({ cmd: "ls", wait: 3 });
    expect(both).toEqual({
      kind: "invalid",
      message: "os.shell.run: pass one of cmd, wait, kill, jobs (got cmd, wait)",
    });
    const three = classifyShellCall({ cmd: "ls", wait: 3, kill: 2, jobs: true });
    expect(three.kind).toBe("invalid");
    expect(three.kind === "invalid" && three.message).toContain("(got cmd, wait, kill, jobs)");
  });

  it("accepts positive job ids as numbers and numeric strings", () => {
    expect(classifyShellCall({ wait: 1 })).toEqual({ kind: "wait", id: 1 });
    expect(classifyShellCall({ wait: " 12 ", timeoutMs: 0, keep: true })).toEqual({
      kind: "wait",
      id: 12,
    });
    expect(classifyShellCall({ kill: 7 })).toEqual({ kind: "kill", id: 7 });
    expect(classifyShellCall({ jobs: true })).toEqual({ kind: "jobs" });
  });

  it("never turns a zero into job 0; a non-id value is still refused", () => {
    // A lone zero is no job form at all: it falls through to the cmd
    // form, whose own check refuses the missing command.
    expect(classifyShellCall({ wait: 0 })).toEqual({ kind: "cmd" });
    expect(classifyShellCall({ kill: 0 })).toEqual({ kind: "cmd" });
    for (const bad of [-1, 1.5, "soon", true]) {
      const form = classifyShellCall({ wait: bad });
      expect(form.kind).toBe("invalid");
      expect(form.kind === "invalid" && form.message).toContain("wait must be a job id");
    }
  });
});
