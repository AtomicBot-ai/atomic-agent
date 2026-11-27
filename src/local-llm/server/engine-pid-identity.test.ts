import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dropNonEnginePid,
  isEngineImage,
  judgeEnginePid,
  parseTasklistImage,
  readProcessImage,
  type EnginePidDeps,
} from "./engine-pid-identity.js";
import { stopProcess } from "./port-reclaim.js";

/**
 * ATO-2766: a pid file outlives a reboot or a crash and Windows reuses
 * pids fast, so a stop must never signal a pid that is not our
 * llama-server: not the agent, not its parent (the desktop), not a
 * process that took the number.
 */

const SELF = 1000;
const PARENT = 999;
const deps = (image: string | null, platform: NodeJS.Platform = "win32"): EnginePidDeps => ({
  platform,
  selfPid: SELF,
  parentPid: PARENT,
  readImage: async () => image,
});

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("isEngineImage", () => {
  it.each([
    "C:\\Users\\me\\.atomic-agent\\models\\backend\\llama-server.exe",
    "C:\\x\\core\\versions\\1\\data\\llamacpp\\backends\\b1\\build\\bin\\LLAMA-SERVER.EXE",
    "/Users/me/.atomic-agent/models/backend/llama-server",
    "/home/me/.atomic-agent/models/backend/llama-server (deleted)",
    "llama-server.exe",
  ])("accepts %s", (image) => {
    expect(isEngineImage(image)).toBe(true);
  });

  it.each([
    "C:\\Program Files\\Atomic Agent\\Atomic Agent.exe",
    "C:\\Users\\me\\AppData\\Local\\atag\\atag.exe",
    "node.exe",
    "/usr/bin/llama-server-wrapper",
    "/opt/llama-server/bin/ollama",
    "",
  ])("refuses %s", (image) => {
    expect(isEngineImage(image)).toBe(false);
  });
});

describe("judgeEnginePid", () => {
  it("never signals this process or its parent, whatever the image says", async () => {
    const llama = deps("C:\\a\\backend\\llama-server.exe");
    expect(await judgeEnginePid(SELF, llama)).toMatchObject({ signal: false, why: "self" });
    expect(await judgeEnginePid(PARENT, llama)).toMatchObject({ signal: false, why: "parent" });
  });

  it("defaults to the real process.pid and process.ppid", async () => {
    const llama: EnginePidDeps = { platform: "win32", readImage: async () => "llama-server.exe" };
    expect((await judgeEnginePid(process.pid, llama)).signal).toBe(false);
    expect((await judgeEnginePid(process.ppid, llama)).signal).toBe(false);
  });

  it("signals a real llama-server", async () => {
    expect(await judgeEnginePid(4242, deps("C:\\a\\backend\\llama-server.exe"))).toEqual({ signal: true });
    expect(await judgeEnginePid(4242, deps("/a/backend/llama-server", "darwin"))).toEqual({ signal: true });
  });

  it("does not signal a pid another program took", async () => {
    expect(await judgeEnginePid(4242, deps("C:\\Program Files\\Atomic Agent\\Atomic Agent.exe"))).toMatchObject({
      signal: false,
      why: "not-engine",
    });
    expect((await judgeEnginePid(4242, deps("/usr/bin/zsh", "linux"))).signal).toBe(false);
  });

  it("an unreadable image fails closed on Windows only", async () => {
    expect(await judgeEnginePid(4242, deps(null, "win32"))).toMatchObject({ signal: false, why: "unknown" });
    expect(await judgeEnginePid(4242, { ...deps(null), readImage: async () => { throw new Error("boom"); } }))
      .toMatchObject({ signal: false, why: "unknown" });
    expect(await judgeEnginePid(4242, deps(null, "darwin"))).toEqual({ signal: true });
    expect(await judgeEnginePid(4242, deps(null, "linux"))).toEqual({ signal: true });
  });
});

describe("dropNonEnginePid", () => {
  function files(): { pidPath: string; logPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "engine-pid-"));
    dirs.push(dir);
    const pidPath = join(dir, "llama-server.pid");
    writeFileSync(pidPath, "4242", "utf-8");
    return { pidPath, logPath: join(dir, "llama-server.log") };
  }

  it("removes the pid file of a pid that is not our server and notes it in the log", async () => {
    const { pidPath, logPath } = files();
    expect(await dropNonEnginePid(4242, pidPath, logPath, deps("C:\\Windows\\explorer.exe"))).toBe(true);
    expect(existsSync(pidPath)).toBe(false);
    expect(readFileSync(logPath, "utf-8")).toContain("recorded pid 4242 is explorer.exe, not llama-server");
  });

  it("leaves the pid file of our llama-server for the stop to handle", async () => {
    const { pidPath, logPath } = files();
    expect(await dropNonEnginePid(4242, pidPath, logPath, deps("C:\\a\\backend\\llama-server.exe"))).toBe(false);
    expect(existsSync(pidPath)).toBe(true);
    expect(existsSync(logPath)).toBe(false);
  });
});

describe("readProcessImage on Windows", () => {
  it("reads the image name from tasklist", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '"llama-server.exe","4242","Console","1","1,234 K"\r\n' }));
    expect(await readProcessImage(4242, "win32", run)).toBe("llama-server.exe");
    expect(run).toHaveBeenCalledWith("tasklist", ["/FI", "PID eq 4242", "/FO", "CSV", "/NH"]);
  });

  it("falls back to the CIM executable path when tasklist gives nothing", async () => {
    const run = vi.fn(async (file: string) =>
      file === "tasklist" ? { code: 0, stdout: "INFO: No tasks are running which match the specified criteria.\r\n" }
        : { code: 0, stdout: "C:\\a\\backend\\llama-server.exe\r\n" });
    expect(await readProcessImage(4242, "win32", run)).toBe("C:\\a\\backend\\llama-server.exe");
  });

  it("is null when neither answers", async () => {
    expect(await readProcessImage(4242, "win32", async () => null)).toBeNull();
  });

  it("parseTasklistImage only takes the row of that pid", () => {
    expect(parseTasklistImage('"node.exe","1","Console","1","5 K"', 4242)).toBeNull();
  });
});

describe("port reclaim's stopProcess", () => {
  function killSpy(): Array<string | number | undefined> {
    const calls: Array<string | number | undefined> = [];
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      calls.push(signal);
      if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    });
    return calls;
  }

  it("sends no signal to a pid that is not a llama-server", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const calls = killSpy();
    await stopProcess(4242, deps("/Applications/Safari.app/Contents/MacOS/Safari", "darwin"));
    expect(calls).toEqual([]);
  });

  it("sends no signal to this process or its parent", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const calls = killSpy();
    await stopProcess(SELF, deps("/a/backend/llama-server", "darwin"));
    await stopProcess(PARENT, deps("/a/backend/llama-server", "darwin"));
    expect(calls).toEqual([]);
  });

  it("still stops a real llama-server", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const calls = killSpy();
    await stopProcess(4242, deps("/a/backend/llama-server", "darwin"));
    expect(calls).toContain("SIGTERM");
  });
});
