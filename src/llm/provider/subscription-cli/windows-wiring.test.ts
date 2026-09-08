import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The shim is a passthrough on every platform but Windows, so on this
 * machine nothing proves that either CLI path calls it at all: delete
 * the call and the whole suite still passes. These tests pretend the
 * host is win32 (`host-environment.js` is the seam) and mock `spawn`, so
 * the real shim runs its real win32 branch under the real wiring — and
 * what lands on `spawn` is asserted.
 *
 * They also pin the pieces of the rewrite that a "simplification" would
 * quietly drop: `win32.normalize` on the target, `escapeCommand` on it
 * (the real path is `…\AppData\Roaming\npm\claude.cmd`, and
 * `Program Files (x86)` is just as ordinary), and the tree-kill on abort
 * — including its escalation, which is the only thing that reaps the
 * tree when the polite pass is refused.
 */
const state = vi.hoisted(() => ({
  files: new Set<string>(),
  shimBody: 'endLocal & "%_prog%" "%dp0%\\cli.js" %*',
  spawns: [] as { file: string; args: readonly string[]; options: unknown }[],
  children: [] as EventEmitter[],
  taskkills: [] as EventEmitter[],
  autoClose: true,
  taskkillSpawnFails: false,
}));

vi.mock("./host-environment.js", () => ({
  hostPlatform: () => "win32",
  hostEnv: () => ({
    PATH: "C:\\npm",
    PATHEXT: ".CMD",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
  }),
  hostFileStatus: (path: string) =>
    state.files.has(path.toLowerCase()) ? "present" : "absent",
  readShimHead: () => state.shimBody,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (file: string, args: readonly string[], options: unknown) => {
      state.spawns.push({ file, args, options });
      if (file === "taskkill" && state.taskkillSpawnFails) {
        throw new Error("EPERM");
      }
      const child = Object.assign(new EventEmitter(), {
        pid: 4242,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        killed: [] as unknown[],
        kill(signal?: unknown) {
          (child as unknown as { killed: unknown[] }).killed.push(signal);
          return true;
        },
      });
      // `taskkill` is spawned by the tree-kill; it has no streams to
      // drive and must not be mistaken for the CLI child. Its exit code
      // is what decides whether the tree really died, so tests drive it.
      if (file === "taskkill") {
        state.taskkills.push(child);
      } else {
        state.children.push(child);
        if (state.autoClose) {
          setImmediate(() => {
            child.stdout.end();
            child.emit("close", 0, null);
          });
        }
      }
      return child;
    },
  };
});

const { runCliCommand } = await import("./run-cli-completion.js");
const { streamCliCommand } = await import("./stream-cli-completion.js");

/** A configured `binPath`, in the shape a real Windows install has. */
const BIN_PATH = "C:/Users/Some One/AppData/Roaming/npm (x86)/claude.cmd";
const EXPECTED_COMMAND_LINE =
  '"C:\\Users\\Some^ One\\AppData\\Roaming\\npm^ ^(x86^)\\claude.cmd ^^^"--print^^^""';

function options(extra: Record<string, unknown> = {}) {
  return {
    binary: BIN_PATH,
    args: ["--print"],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
    installHint: "Install Claude Code.",
    authHint: "Run /login.",
    ...extra,
  };
}

function cliSpawns() {
  return state.spawns.filter((call) => call.file !== "taskkill");
}

function taskkillArgs() {
  return state.spawns
    .filter((call) => call.file === "taskkill")
    .map((call) => call.args);
}

/** Start a streaming turn that stays open until the test closes it. */
async function startAbortableTurn() {
  state.autoClose = false;
  const controller = new AbortController();
  const iterator = streamCliCommand(options({ signal: controller.signal }));
  const first = iterator.next();
  await new Promise((resolve) => setImmediate(resolve));
  const child = state.children[0] as unknown as {
    killed: unknown[];
    stdout: PassThrough;
    emit: (event: string, ...args: unknown[]) => boolean;
  };
  return {
    controller,
    child,
    async finish() {
      child.stdout.end();
      child.emit("close", null, "SIGTERM");
      await first.catch(() => {});
      await iterator.return(undefined).catch(() => {});
    },
  };
}

beforeEach(() => {
  state.files = new Set([BIN_PATH.toLowerCase()]);
  state.spawns = [];
  state.children = [];
  state.taskkills = [];
  state.autoClose = true;
  state.taskkillSpawnFails = false;
  state.shimBody = 'endLocal & "%_prog%" "%dp0%\\cli.js" %*';
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the Windows shim as both CLI paths use it", () => {
  it("sends the streaming path through cmd.exe with an escaped command line", async () => {
    const lines: string[] = [];
    for await (const line of streamCliCommand(options())) lines.push(line);

    expect(cliSpawns()).toHaveLength(1);
    const call = cliSpawns()[0];
    expect(call?.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(call?.args).toEqual(["/d", "/s", "/c", EXPECTED_COMMAND_LINE]);
    // `windowsHide` reads the same host seam as everything else, so the
    // faked win32 host produces the options production would.
    expect(call?.options).toMatchObject({
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
  });

  it("sends the buffered path through cmd.exe the same way", async () => {
    await runCliCommand(options());

    expect(cliSpawns()).toHaveLength(1);
    const call = cliSpawns()[0];
    expect(call?.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(call?.args).toEqual(["/d", "/s", "/c", EXPECTED_COMMAND_LINE]);
    expect(call?.options).toMatchObject({ windowsVerbatimArguments: true });
  });

  it("stops the whole process tree when a streaming turn is aborted", async () => {
    // The direct child is cmd.exe; the CLI is its grandchild. Before
    // this, `child.kill` on the wrapper's pid left the real CLI running
    // — one orphan per Ctrl+C, which is the most routine action there is.
    const turn = await startAbortableTurn();

    turn.controller.abort();
    expect(state.spawns.filter((call) => call.file === "taskkill")).toEqual([
      {
        file: "taskkill",
        args: ["/PID", "4242", "/T"],
        options: { stdio: "ignore", windowsHide: true },
      },
    ]);
    expect(turn.child.killed).toEqual([]);

    await turn.finish();
  });

  it("escalates to taskkill /F when the polite pass is refused", async () => {
    // taskkill without /F posts WM_CLOSE, and a console process spawned
    // with `windowsHide: true` has no window to receive it: taskkill
    // answers "can only be terminated forcefully" and exits non-zero.
    // Unobserved, that refusal left the tree alive.
    const turn = await startAbortableTurn();

    turn.controller.abort();
    expect(taskkillArgs()).toEqual([["/PID", "4242", "/T"]]);

    state.taskkills[0]?.emit("close", 1, null);
    expect(taskkillArgs()).toEqual([
      ["/PID", "4242", "/T"],
      ["/PID", "4242", "/T", "/F"],
    ]);
    // Not a TerminateProcess at the wrapper: that is what orphans the CLI.
    expect(turn.child.killed).toEqual([]);

    await turn.finish();
  });

  it("leaves the force pass armed when the polite pass could only signal the wrapper", async () => {
    // taskkill missing from a locked-down image: the fallback is
    // `child.kill`, which on Windows terminates `cmd.exe` alone. Its
    // `close` used to disarm the escalation — so the grandchild survived
    // the abort, which is exactly the orphan this whole path is about.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    state.taskkillSpawnFails = true;
    const turn = await startAbortableTurn();

    turn.controller.abort();
    expect(turn.child.killed).toEqual(["SIGTERM"]);

    await turn.finish();
    vi.advanceTimersByTime(2_000);
    expect(turn.child.killed).toEqual(["SIGTERM", "SIGKILL"]);
    expect(taskkillArgs()).toEqual([
      ["/PID", "4242", "/T"],
      ["/PID", "4242", "/T", "/F"],
    ]);
  });

  it("does not force-kill once the tree is confirmed gone", async () => {
    // The other direction: a taskkill that reports success must not be
    // followed 2 s later by `/F` at a pid Windows may have recycled.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const turn = await startAbortableTurn();

    turn.controller.abort();
    state.taskkills[0]?.emit("close", 0, null);
    await turn.finish();
    vi.advanceTimersByTime(2_000);

    expect(taskkillArgs()).toEqual([["/PID", "4242", "/T"]]);
    expect(turn.child.killed).toEqual([]);
  });
});
