import { describe, expect, it } from "vitest";

import type { ScreenCommandResult, ScreenDeps } from "../tools/os/screen/screen-host.js";
import { parseMacIdleMs, probeFrontWindow } from "./logbook-front-window.js";
import { NO_X11_TOOL_REASON, parseActiveWindowId, parseXpropWindow, WAYLAND_REASON } from "./logbook-front-window-linux.js";
import { parseWindowsFrontWindow, WINDOWS_FRONT_WINDOW_SCRIPT } from "./logbook-front-window-win.js";

/** ATO-2526: which window is in front, per platform, with no real screen touched. */
function screen(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, answer: (command: string, args: readonly string[]) => ScreenCommandResult) {
  const calls: string[] = [];
  const deps: ScreenDeps = {
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      return answer(command, args);
    },
    platform,
    env,
    fileSize: async () => 0,
    readHead: async () => new Uint8Array(),
    ensureDir: async () => undefined,
    writeText: async () => undefined,
    now: () => new Date(),
    tmpDir: "/tmp",
  };
  return { deps, calls };
}

const ok = (stdout: string): ScreenCommandResult => ({ exitCode: 0, stdout, stderr: "" });
const ctx = { workingDir: "/w", signal: new AbortController().signal };

describe("front window on Windows", () => {
  it("reads the process, its description, the title and the idle time", () => {
    const result = parseWindowsFrontWindow('noise\n{"title":"Report.docx - Word","process":"WINWORD","description":"Microsoft Word","idleMs":1200}');
    expect(result).toEqual({
      ok: true,
      probe: { app: { name: "Microsoft Word", bundleId: "winword" }, title: "Report.docx - Word", idleMs: 1200, screenRecording: null },
    });
  });

  it("falls back to the process name, and has no app for an empty desktop", () => {
    const named = parseWindowsFrontWindow('{"title":"","process":"KeePass","description":"","idleMs":-1}');
    expect(named).toMatchObject({ ok: true, probe: { app: { name: "KeePass", bundleId: "keepass" }, idleMs: null } });
    expect(parseWindowsFrontWindow('{"title":"","process":"","description":"","idleMs":0}')).toMatchObject({ ok: true, probe: { app: null } });
    expect(parseWindowsFrontWindow("not json").ok).toBe(false);
  });

  it("asks the foreground window and the last input through the Win32 calls", () => {
    expect(WINDOWS_FRONT_WINDOW_SCRIPT).toMatch(/GetForegroundWindow/);
    expect(WINDOWS_FRONT_WINDOW_SCRIPT).toMatch(/GetWindowText/);
    expect(WINDOWS_FRONT_WINDOW_SCRIPT).toMatch(/GetLastInputInfo/);
  });
});

describe("front window on Linux", () => {
  it("is refused on Wayland with a hint, before running anything", async () => {
    const s = screen("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, () => ok(""));
    expect(await probeFrontWindow(s.deps, ctx, { withTitle: true })).toEqual({ ok: false, reason: WAYLAND_REASON });
    expect(s.calls).toEqual([]);
  });

  it("reads the active window's class and title with xprop, and the idle time with xprintidle", async () => {
    const s = screen("linux", { DISPLAY: ":0" }, (command, args) => {
      if (command === "sh") return ok("xprop\nxprintidle\n");
      if (command === "xprintidle") return ok("4200\n");
      if (args[0] === "-root") return ok("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007\n");
      return ok('WM_CLASS(STRING) = "keepassxc", "KeePassXC"\n_NET_WM_NAME(UTF8_STRING) = "Passwords - KeePassXC"\n');
    });
    expect(await probeFrontWindow(s.deps, ctx, { withTitle: true })).toEqual({
      ok: true,
      probe: { app: { name: "KeePassXC", bundleId: "keepassxc" }, title: "Passwords - KeePassXC", idleMs: 4200, screenRecording: null },
    });
    expect(s.calls).toContain("xprop -id 0x3a00007 WM_CLASS _NET_WM_NAME WM_NAME");
  });

  it("uses xdotool when xprop is missing, and says what to install when both are", async () => {
    const withXdotool = screen("linux", { DISPLAY: ":0" }, (command) => (command === "sh" ? ok("xdotool\n") : ok("firefox\nNews - Firefox\n")));
    expect(await probeFrontWindow(withXdotool.deps, ctx, { withTitle: false })).toMatchObject({
      ok: true,
      probe: { app: { bundleId: "firefox" }, title: "News - Firefox", idleMs: null },
    });
    const none = screen("linux", { DISPLAY: ":0" }, () => ok(""));
    expect(await probeFrontWindow(none.deps, ctx, { withTitle: false })).toEqual({ ok: false, reason: NO_X11_TOOL_REASON });
  });

  it("parses xprop's lines", () => {
    expect(parseActiveWindowId("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0")).toBeNull();
    expect(parseXpropWindow('WM_CLASS(STRING) = "code"\nWM_NAME(STRING) = "a \\"b\\""')).toEqual({ instance: "code", className: "code", title: 'a "b"' });
  });
});

describe("front window on macOS", () => {
  it("turns ioreg's HIDIdleTime nanoseconds into milliseconds", () => {
    expect(parseMacIdleMs('    |   "HIDIdleTime" = 2500000000\n')).toBe(2500);
    expect(parseMacIdleMs("nothing")).toBeNull();
  });

  it("takes the title of the front app's first window when asked", async () => {
    const s = screen("darwin", {}, (command) => {
      if (command === "ioreg") return ok('"HIDIdleTime" = 1000000');
      return ok(JSON.stringify({
        accessibility: true,
        screenRecording: true,
        frontmost: { name: "Mail", bundleId: "com.apple.mail" },
        screen: { width: 1, height: 1, scale: 1 },
        done: false,
        windows: [{ id: 1, pid: 2, app: "Mail", bundleId: "com.apple.mail", title: "Inbox", x: 0, y: 0, width: 1, height: 1 }],
      }));
    });
    expect(await probeFrontWindow(s.deps, ctx, { withTitle: true })).toEqual({
      ok: true,
      probe: { app: { name: "Mail", bundleId: "com.apple.mail" }, title: "Inbox", idleMs: 1, screenRecording: true },
    });
  });
});
