import { describe, it, expect } from "vitest";

import {
  agentArgv,
  buildTerminalLaunch,
  type TerminalLaunchInput,
} from "./build-terminal-launch.js";

function input(overrides: Partial<TerminalLaunchInput> = {}): TerminalLaunchInput {
  return {
    platform: "darwin",
    execPath: "/usr/local/bin/node",
    argv: ["/usr/local/bin/node", "/opt/atomic/dist/cli/index.js", "tui"],
    isSea: false,
    cwd: "/home/val/work",
    env: {},
    hasBinary: () => false,
    ...overrides,
  };
}

describe("agentArgv", () => {
  it("keeps the script path under plain node", () => {
    expect(agentArgv(input())).toEqual([
      "/usr/local/bin/node",
      "/opt/atomic/dist/cli/index.js",
      "tui",
    ]);
  });

  it("drops the script slot for a SEA binary", () => {
    // A SEA binary is its own entry point; re-injecting argv[1] makes the
    // child read the invoke path as a command name ("unknown command").
    expect(
      agentArgv(
        input({
          isSea: true,
          execPath: "/usr/local/bin/atomic-agent",
          argv: ["/usr/local/bin/atomic-agent", "/usr/local/bin/atomic-agent"],
        }),
      ),
    ).toEqual(["/usr/local/bin/atomic-agent", "tui"]);
  });

  it("always asks for the tui explicitly", () => {
    // The parent may have been started as `atomic-agent` with no args.
    expect(agentArgv(input({ argv: ["/usr/local/bin/node", "/opt/a.js"] }))).toContain(
      "tui",
    );
  });
});

describe("buildTerminalLaunch — macOS", () => {
  it("drives Terminal.app through osascript, cd'ing into the working dir", () => {
    const launch = buildTerminalLaunch(input());
    expect(launch).not.toBeNull();
    expect(launch?.cmd).toBe("osascript");
    expect(launch?.label).toBe("Terminal");
    const script = launch?.args[1] ?? "";
    expect(script).toContain('tell application "Terminal" to do script');
    expect(script).toContain("cd '/home/val/work'");
    expect(script).toContain("/opt/atomic/dist/cli/index.js");
    expect(script).toContain("tui");
    expect(launch?.args[3]).toContain("activate");
  });

  it("uses iTerm when the operator already lives in iTerm", () => {
    const launch = buildTerminalLaunch(
      input({ env: { TERM_PROGRAM: "iTerm.app" } }),
    );
    expect(launch?.label).toBe("iTerm");
    expect(launch?.args[1]).toContain('tell application "iTerm"');
  });

  it("carries a non-default state dir into the new window", () => {
    // The spawned terminal starts a login shell and inherits nothing —
    // without this the second window would use a different state dir.
    const launch = buildTerminalLaunch(
      input({ env: { ATOMIC_AGENT_STATE_DIR: "/tmp/state dir" } }),
    );
    expect(launch?.args[1]).toContain(
      "ATOMIC_AGENT_STATE_DIR='/tmp/state dir'",
    );
  });

  it("escapes quotes in paths for both the shell and AppleScript layers", () => {
    const launch = buildTerminalLaunch(input({ cwd: `/home/o'brien/work` }));
    const script = launch?.args[1] ?? "";
    // POSIX single-quote escaping, with its backslash doubled by the
    // AppleScript escaper so the shell still sees exactly one.
    expect(script).toContain(`cd '/home/o'\\\\''brien/work'`);
    // And nothing unescaped can close the AppleScript string literal.
    const body = script.slice(script.indexOf("do script ") + "do script ".length);
    expect(body.slice(1, -1)).not.toMatch(/(^|[^\\])"/);
  });
});

describe("buildTerminalLaunch — Linux", () => {
  it("returns null when no emulator is installed", () => {
    // Headless box: report it, never throw into the render loop.
    expect(buildTerminalLaunch(input({ platform: "linux" }))).toBeNull();
  });

  it("prefers gnome-terminal's `--` argv shape", () => {
    const launch = buildTerminalLaunch(
      input({ platform: "linux", hasBinary: (n) => n === "gnome-terminal" }),
    );
    expect(launch?.cmd).toBe("gnome-terminal");
    expect(launch?.args[0]).toBe("--");
    expect(launch?.args[1]).toBe("sh");
  });

  it("falls back to xterm when nothing better exists", () => {
    const launch = buildTerminalLaunch(
      input({ platform: "linux", hasBinary: (n) => n === "xterm" }),
    );
    expect(launch?.cmd).toBe("xterm");
    expect(launch?.args[0]).toBe("-e");
  });

  it("honours $ATOMIC_AGENT_TERMINAL over the probe order", () => {
    const launch = buildTerminalLaunch(
      input({
        platform: "linux",
        env: { ATOMIC_AGENT_TERMINAL: "foot", TERMINAL: "xterm" },
        hasBinary: () => true,
      }),
    );
    expect(launch?.cmd).toBe("foot");
    expect(launch?.args).toEqual(["-e", "sh", "-c", expect.any(String)]);
  });

  it("keeps the window alive after the agent exits", () => {
    // `-e` closes the window the moment the command returns, which would
    // eat a startup error before anyone could read it.
    const launch = buildTerminalLaunch(
      input({ platform: "linux", hasBinary: (n) => n === "xterm" }),
    );
    expect(launch?.args.at(-1)).toContain('exec "${SHELL:-sh}"');
  });
});

describe("buildTerminalLaunch — Windows", () => {
  it("opens a new Windows Terminal window when wt.exe is present", () => {
    const launch = buildTerminalLaunch(
      input({
        platform: "win32",
        hasBinary: (n) => n === "wt.exe",
        cwd: "C:\\work",
      }),
    );
    expect(launch?.cmd).toBe("wt.exe");
    expect(launch?.args.slice(0, 5)).toEqual(["-w", "-1", "nt", "-d", "C:\\work"]);
    expect(launch?.args).toContain("tui");
  });

  it("falls back to a `start`-ed cmd.exe that stays open", () => {
    const launch = buildTerminalLaunch(
      input({ platform: "win32", cwd: "C:\\work" }),
    );
    expect(launch?.cmd).toBe("cmd.exe");
    expect(launch?.args.slice(0, 5)).toEqual([
      "/c",
      "start",
      "atomic-agent",
      "cmd",
      "/k",
    ]);
  });
});
