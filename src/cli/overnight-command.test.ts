import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { spawn } from "node:child_process";

import { getConfig, resetConfigCache } from "../config/index.js";
import { overnightCommand } from "./overnight-command.js";

/**
 * The foreground run boots `createAgentRuntime` against the real model
 * wiring and is out of scope here, as for `task run`. This suite covers
 * help, refusals and the `--detach` hand-off with a fake spawn.
 */
describe("overnightCommand", () => {
  let stateDir: string;
  let workDir: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-overnight-state-"));
    workDir = mkdtempSync(join(tmpdir(), "atomic-overnight-work-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  it("prints help", async () => {
    expect(await overnightCommand(["--help"])).toBe(0);
    expect(out.join("")).toContain('atomic-agent overnight "<task>"');
    expect(out.join("")).not.toContain("--task-id");
  });

  it("refuses a bad flag before starting anything", async () => {
    const fakeSpawn = vi.fn();
    const code = await overnightCommand(["x", "--hours", "-1", "--detach"], {
      spawn: fakeSpawn as unknown as typeof spawn,
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("--hours expects");
    expect(fakeSpawn).not.toHaveBeenCalled();
  });

  it("--detach starts a background child in --dir and prints how to check it", async () => {
    const unref = vi.fn();
    const fakeSpawn = vi.fn(() => ({ pid: 4242, unref }));
    const code = await overnightCommand(
      ["write the notes", "--dir", workDir, "--budget", "3", "--detach"],
      { spawn: fakeSpawn as unknown as typeof spawn, newTaskId: () => "t-fixed" },
    );
    expect(code).toBe(0);
    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    const [, childArgs, options] = fakeSpawn.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; detached: boolean },
    ];
    const tail = childArgs.slice(childArgs.indexOf("overnight"));
    expect(tail).toEqual([
      "overnight",
      "write the notes",
      "--budget",
      "3",
      "--hours",
      "8",
      "--dir",
      workDir,
      "--task-id",
      "t-fixed",
    ]);
    expect(options.cwd).toBe(workDir);
    expect(options.detached).toBe(true);
    expect(unref).toHaveBeenCalled();
    const logPath = join(getConfig().paths.stateDir, "logs", "overnight-t-fixed.log");
    expect(existsSync(logPath)).toBe(true);
    const printed = out.join("");
    expect(printed).toContain("t-fixed");
    expect(printed).toContain("atomic-agent task show t-fixed");
    expect(printed).toContain(logPath);
  });
});
