import { afterEach, describe, expect, it, vi } from "vitest";
import {
  needsShellInterpretation,
  resolveShellSpawn,
} from "./shell-interpretation.js";

const COMSPEC = "C:\\Windows\\system32\\cmd.exe";

/** What `os.shell.run` spawns for this call (no glob args in these cases). */
function spawnFor(cmd: string, args: string[] = []) {
  return resolveShellSpawn(cmd, args, needsShellInterpretation(cmd, args));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ATO-246: `cmd /c dir C:\` failed with "The filename, directory name, or
// volume label syntax is incorrect." — Node quoted the subshell line by
// MSVCRT rules and cmd got `dir C:\\`. Every shape the model may send it
// in must reach cmd.exe with the backslash single.
describe("resolveShellSpawn on Windows (ATO-246)", () => {
  function win32(): void {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("ComSpec", COMSPEC);
  }

  it("`cmd /c dir C:\\` as one command line", () => {
    win32();
    expect(spawnFor("cmd /c dir C:\\")).toEqual({
      command: COMSPEC,
      args: ["/d", "/s", "/c", '"cmd /c dir C:\\"'],
      windowsVerbatimArguments: true,
    });
  });

  it("`cmd` with `/c`, `dir`, `C:\\` as separate args", () => {
    win32();
    expect(spawnFor("cmd", ["/c", "dir", "C:\\"])).toEqual({
      command: "cmd",
      args: ["/c", "dir", "C:\\"],
      windowsVerbatimArguments: true,
    });
  });

  it("`cmd` with the rest of the line as one arg", () => {
    win32();
    expect(spawnFor("cmd", ["/c", "dir C:\\"])).toEqual({
      command: "cmd",
      args: ["/c", '"dir C:\\"'],
      windowsVerbatimArguments: true,
    });
  });

  it('`dir "C:\\Program Files\\"` as one command line', () => {
    win32();
    expect(spawnFor('dir "C:\\Program Files\\"').args).toEqual([
      "/d",
      "/s",
      "/c",
      '"dir "C:\\Program Files\\""',
    ]);
  });

  it("the `dir` builtin with a spaced path ending in `\\` as an arg", () => {
    win32();
    expect(spawnFor("dir", ["C:\\Program Files\\"])).toEqual({
      command: COMSPEC,
      args: ["/d", "/s", "/c", '"dir "C:\\Program Files\\""'],
      windowsVerbatimArguments: true,
    });
  });

  it("the `dir` builtin with `C:\\` as an arg", () => {
    win32();
    expect(spawnFor("dir", ["C:\\"]).args[3]).toBe('"dir C:\\"');
  });

  it("leaves an ordinary executable to Node's quoting", () => {
    win32();
    expect(spawnFor("git", ["status", "C:\\a b\\"])).toEqual({
      command: "git",
      args: ["status", "C:\\a b\\"],
      windowsVerbatimArguments: false,
    });
  });
});

describe("resolveShellSpawn on POSIX", () => {
  function posix(): void {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  }

  it("runs a command line through `sh -c` as written", () => {
    posix();
    expect(spawnFor("ls -la | grep x")).toEqual({
      command: "sh",
      args: ["-c", "ls -la | grep x"],
      windowsVerbatimArguments: false,
    });
  });

  it("joins args onto a shell-bearing cmd raw", () => {
    posix();
    expect(spawnFor("cat $F |", ["grep", "a b"]).args).toEqual([
      "-c",
      "cat $F | grep a b",
    ]);
  });

  it("spawns a structured command directly", () => {
    posix();
    expect(spawnFor("cmd", ["/c", "dir", "C:\\"])).toEqual({
      command: "cmd",
      args: ["/c", "dir", "C:\\"],
      windowsVerbatimArguments: false,
    });
  });
});
