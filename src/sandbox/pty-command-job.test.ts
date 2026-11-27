import { describe, expect, it } from "vitest";

import type {
  NodePtyModule,
  NodePtyProcess,
  NodePtySpawnOptions,
} from "../native/load-node-pty.js";
import {
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
  startPtyCommandJob,
  terminalEof,
  toTerminalKeys,
} from "./pty-command-job.js";

/** A pty that records what it was given and lets the test drive it. */
function fakePty() {
  const spawned: Array<{ file: string; args: string[] | string; options: NodePtySpawnOptions }> = [];
  const typed: string[] = [];
  const sizes: Array<[number, number]> = [];
  const killed: Array<string | undefined> = [];
  let data: (text: string) => void = () => undefined;
  let exit: (event: { exitCode: number; signal?: number }) => void = () => undefined;
  const proc: NodePtyProcess = {
    pid: 4242,
    cols: 0,
    rows: 0,
    onData(listener) {
      data = listener;
      return { dispose: () => undefined };
    },
    onExit(listener) {
      exit = listener;
      return { dispose: () => undefined };
    },
    write: (text) => typed.push(text),
    resize: (cols, rows) => sizes.push([cols, rows]),
    kill: (signal) => killed.push(signal),
  };
  const module: NodePtyModule = {
    spawn(file, args, options) {
      spawned.push({ file, args, options });
      return proc;
    },
  };
  return { module, spawned, typed, sizes, killed, print: (t: string) => data(t), end: (e: { exitCode: number; signal?: number }) => exit(e) };
}

/** ATO-2484: an interactive job on node-pty, behind the CommandJob contract. */
describe("startPtyCommandJob", () => {
  it("spawns on a terminal of the default size with a string-only env", () => {
    const pty = fakePty();
    const job = startPtyCommandJob(pty.module, "python3", ["-q"], {
      cwd: "/work",
      env: { TERM: "dumb", HOME: "/h", UNSET: undefined },
      platform: "linux",
    });
    expect(pty.spawned).toHaveLength(1);
    const { file, args, options } = pty.spawned[0]!;
    expect(file).toBe("python3");
    expect(args).toEqual(["-q"]);
    expect(options).toMatchObject({ name: "dumb", cols: DEFAULT_PTY_COLS, rows: DEFAULT_PTY_ROWS, cwd: "/work" });
    expect(options.env).toEqual({ TERM: "dumb", HOME: "/h" });
    expect(job.pid).toBe(4242);
    expect(job.terminalSize()).toEqual({ cols: DEFAULT_PTY_COLS, rows: DEFAULT_PTY_ROWS });
  });

  it("Windows: a ready cmd.exe line goes to ConPTY as one string", () => {
    const pty = fakePty();
    startPtyCommandJob(pty.module, "cmd.exe", ["/d", "/s", "/c", '"npm init"'], {
      cwd: "C:\\w",
      env: {},
      windowsVerbatimArguments: true,
      platform: "win32",
    });
    expect(pty.spawned[0]!.args).toBe('/d /s /c "npm init"');
  });

  it("output is captured and heard; typed Enter becomes \\r; eof is Ctrl+D", () => {
    const pty = fakePty();
    const job = startPtyCommandJob(pty.module, "sh", [], { cwd: "/", env: {}, platform: "darwin" });
    const heard: string[] = [];
    job.onOutput((text, stream) => heard.push(`${stream}:${text}`));
    pty.print("$ ");
    expect(job.write("echo hi\n")).toBe(true);
    pty.print("hi\r\n");
    expect(pty.typed).toEqual(["echo hi\r"]);
    expect(heard).toEqual(["stdout:$ ", "stdout:hi\r\n"]);
    expect(job.output()).toEqual({ stdout: "$ hi\r\n", stderr: "", truncated: false });
    job.endInput();
    expect(pty.typed.at(-1)).toBe("\u0004");
    // input closed: a later write says so instead of typing
    expect(job.write("more\n")).toBe(false);
  });

  it("reports the exit code, or the signal by name", async () => {
    const a = fakePty();
    const jobA = startPtyCommandJob(a.module, "sh", [], { cwd: "/", env: {}, platform: "linux" });
    a.end({ exitCode: 3 });
    await expect(jobA.exit).resolves.toMatchObject({ exitCode: 3, signal: null });
    expect(await jobA.waitFor(10)).toBe("exited");
    expect(jobA.write("x")).toBe(false);
    expect(jobA.resize(80, 24)).toBe(false);

    const b = fakePty();
    const jobB = startPtyCommandJob(b.module, "sh", [], { cwd: "/", env: {}, platform: "linux" });
    b.end({ exitCode: 0, signal: 9 });
    await expect(jobB.exit).resolves.toMatchObject({ exitCode: null, signal: "SIGKILL" });
  });

  it("resize clamps and reaches the terminal", () => {
    const pty = fakePty();
    const job = startPtyCommandJob(pty.module, "sh", [], { cwd: "/", env: {}, platform: "linux" });
    expect(job.resize(80.7, 0)).toBe(true);
    expect(pty.sizes).toEqual([[80, 1]]);
    expect(job.terminalSize()).toEqual({ cols: 80, rows: 1 });
  });

  it("a spawn that throws rejects the first wait, like a failed spawn", async () => {
    const module: NodePtyModule = {
      spawn: () => {
        throw new Error("File not found: nope.exe");
      },
    };
    const job = startPtyCommandJob(module, "nope.exe", [], { cwd: "/", env: {}, platform: "win32" });
    await expect(job.waitFor(10)).rejects.toThrow("File not found");
    expect(job.startError()?.message).toContain("File not found");
    expect(job.write("x")).toBe(false);
  });
});

describe("terminal keys", () => {
  it("Enter is \\r; EOF is Ctrl+D, on Windows Ctrl+Z Enter", () => {
    expect(toTerminalKeys("a\nb\r\n")).toBe("a\rb\r");
    expect(terminalEof("darwin")).toBe("\u0004");
    expect(terminalEof("win32")).toBe("\u001a\r");
  });
});
