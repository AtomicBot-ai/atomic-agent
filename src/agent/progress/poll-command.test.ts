import { describe, expect, it } from "vitest";
import { isDeliberatePoll } from "./poll-command.js";

describe("isDeliberatePoll", () => {
  it("treats the background-job wait and list forms as polls", () => {
    expect(isDeliberatePoll("os.shell.run", { wait: 3 })).toBe(true);
    expect(isDeliberatePoll("os.shell.run", { wait: "3", timeoutMs: 60_000 })).toBe(true);
    expect(isDeliberatePoll("os.shell.run", { jobs: true })).toBe(true);
  });

  it("treats a command line that sleeps first as a poll", () => {
    expect(isDeliberatePoll("os.shell.run", { cmd: "sleep 30 && tail -5 build.log" })).toBe(true);
    expect(isDeliberatePoll("os.shell.run", { cmd: "cat status.txt; sleep 1.5" })).toBe(true);
    expect(isDeliberatePoll("os.shell.run", { cmd: "sleep", args: ["60"] })).toBe(true);
    expect(isDeliberatePoll("os.shell.run", { cmd: ["sleep", "5m"] })).toBe(true);
    expect(isDeliberatePoll("os.shell.run", { cmd: "Start-Sleep -Seconds 20; Get-Content log.txt" })).toBe(true);
    expect(isDeliberatePoll("os.shell.run", { cmd: "timeout /t 10 && type log.txt" })).toBe(true);
  });

  it("does not treat ordinary commands as polls", () => {
    expect(isDeliberatePoll("os.shell.run", { cmd: "npm test" })).toBe(false);
    expect(isDeliberatePoll("os.shell.run", { cmd: "git status" })).toBe(false);
    expect(isDeliberatePoll("os.shell.run", { cmd: "sleep 0 && ls" })).toBe(false);
    expect(isDeliberatePoll("os.shell.run", { cmd: "grep sleep notes.md" })).toBe(false);
    expect(isDeliberatePoll("os.shell.run", { cmd: "./sleepy-script.sh 30" })).toBe(false);
    expect(isDeliberatePoll("os.shell.run", { wait: false, cmd: "ls" })).toBe(false);
    expect(isDeliberatePoll("os.shell.run", { cmd: "ls", wait: 0, kill: 0, jobs: false })).toBe(false);
  });

  it("does not treat a job form the shell tool rejects as a poll", () => {
    expect(isDeliberatePoll("os.shell.run", { cmd: "ls", wait: 1 })).toBe(false);
    expect(isDeliberatePoll("os.shell.run", { wait: "soon" })).toBe(false);
    expect(isDeliberatePoll("os.shell.run", { wait: -2 })).toBe(false);
    expect(isDeliberatePoll("os.shell.run", { cmd: "sleep 30", jobs: true })).toBe(false);
  });

  it("only applies to the shell tool", () => {
    expect(isDeliberatePoll("os.fs.read", { cmd: "sleep 30" })).toBe(false);
    expect(isDeliberatePoll("os.shell.run", null)).toBe(false);
  });
});
