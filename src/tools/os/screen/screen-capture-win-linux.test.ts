import { describe, expect, it } from "vitest";
import type { ApprovalGate } from "../../../approval/approval-gate.js";
import { ApprovalDeniedError } from "../../../approval/dangerous-tool.js";
import { buildOsScreenCaptureTool } from "./screen-capture.js";
import {
  DESKTOP_CAPTURE_MAX_BYTES,
  desktopChildEnv,
  LINUX_WHICH_SCRIPT,
  linuxCaptureArgs,
  linuxCaptureCandidates,
  linuxMissingToolMessage,
  linuxSessionKind,
  parsePngSize,
  parseWindowsCaptureReport,
  WINDOWS_CAPTURE_MAX_SIDE_ENV,
  WINDOWS_CAPTURE_OUT_ENV,
  WINDOWS_CAPTURE_SCRIPT,
  windowsCaptureInvocation,
} from "./screen-capture-win-linux.js";
import { ScreenGeometryStore } from "./screen-geometry.js";
import {
  ensurePrivateDir,
  macOnlyMessage,
  type PrivateDirFs,
  type ScreenCommandResult,
  type ScreenDeps,
} from "./screen-host.js";
import { fakeHost, screenCtx } from "./screen-host.fixture.js";

/** A PNG signature plus an IHDR chunk header for `width` x `height`. */
function pngHead(width: number, height: number): Uint8Array {
  const head = new Uint8Array(24);
  head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(head.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return head;
}

interface Call {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
}

type Answer = Partial<ScreenCommandResult> | ((args: readonly string[]) => Partial<ScreenCommandResult>);

/**
 * Deps for one OS with a scripted runner: `answers[command]` says what a
 * command returns (exit 0 and empty output by default). Nothing real runs.
 */
function desktopHost(options: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  answers?: Record<string, Answer>;
  heads?: Uint8Array[];
  fileSize?: number;
}) {
  const calls: Call[] = [];
  const base = fakeHost({ platform: options.platform, env: options.env, pngHeads: options.heads ?? [] });
  const run: ScreenDeps["run"] = async (command, args, opts) => {
    calls.push({ command, args, ...(opts.env ? { env: opts.env } : {}) });
    const raw = options.answers?.[command];
    const answer = typeof raw === "function" ? raw(args) : (raw ?? {});
    return { exitCode: 0, stdout: "", stderr: "", ...answer };
  };
  const deps: ScreenDeps = {
    ...base.deps,
    run,
    fileSize: async () => options.fileSize ?? 345_678,
  };
  const geometry = new ScreenGeometryStore();
  const prompts: Array<Record<string, unknown>> = [];
  let approved = true;
  const approvals = {
    request: async (req: Record<string, unknown>) => {
      prompts.push(req);
      return approved ? { approved: true } : { approved: false, reason: "no" };
    },
  } as unknown as ApprovalGate;
  const tool = buildOsScreenCaptureTool({ approvals, approvalRequired: true, deps, geometry });
  return {
    calls,
    geometry,
    prompts,
    tool,
    deny: () => {
      approved = false;
    },
  };
}

const WINDOWS_ENV = {
  SystemRoot: "C:\\Windows",
  PATH: "C:\\Windows\\System32",
  TEMP: "C:\\Temp",
  OPENROUTER_API_KEY: "sk-or-secret",
};

const WINDOWS_REPORT = JSON.stringify({
  left: -1920,
  top: 0,
  screenWidth: 4480,
  screenHeight: 1440,
  imageWidth: 1280,
  imageHeight: 411,
});

const X11_ENV = { DISPLAY: ":0", PATH: "/usr/bin", HOME: "/home/u", GITHUB_TOKEN: "ghp_secret" };
const WAYLAND_ENV = { WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/run/user/1000", PATH: "/usr/bin" };

const which = (...names: string[]) => ({ stdout: names.map((name) => `${name}\n`).join("") });

describe("Windows capture", () => {
  it("runs the constant PowerShell script as -EncodedCommand with the path in the environment", () => {
    const call = windowsCaptureInvocation("C:\\Temp\\atomic-agent-screens\\s1\\screen-1.png", WINDOWS_ENV);
    expect(call.command).toBe("powershell.exe");
    expect(call.args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    expect(Buffer.from(call.args[5]!, "base64").toString("utf16le")).toBe(WINDOWS_CAPTURE_SCRIPT);
    expect(call.env[WINDOWS_CAPTURE_OUT_ENV]).toBe("C:\\Temp\\atomic-agent-screens\\s1\\screen-1.png");
    expect(call.env[WINDOWS_CAPTURE_MAX_SIDE_ENV]).toBe("1280");
    expect(call.env.SystemRoot).toBe("C:\\Windows");
    expect(call.env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("keeps the script constant: DPI awareness first, the path read from the environment only", () => {
    const dpi = WINDOWS_CAPTURE_SCRIPT.indexOf("SetProcessDPIAware()");
    const metrics = WINDOWS_CAPTURE_SCRIPT.indexOf("VirtualScreen");
    expect(dpi).toBeGreaterThan(0);
    expect(dpi).toBeLessThan(metrics);
    expect(WINDOWS_CAPTURE_SCRIPT).toContain("CopyFromScreen");
    expect(WINDOWS_CAPTURE_SCRIPT).toContain("$env:ATOMIC_SCREEN_OUT");
    expect(WINDOWS_CAPTURE_SCRIPT).not.toContain("atomic-agent-screens");
  });

  it("parses the report and refuses output without a usable size", () => {
    expect(parseWindowsCaptureReport(`warning line\r\n${WINDOWS_REPORT}\r\n`)).toEqual({
      originX: -1920,
      originY: 0,
      screenWidth: 4480,
      screenHeight: 1440,
      imageWidth: 1280,
      imageHeight: 411,
    });
    expect(() => parseWindowsCaptureReport("not json")).toThrow(/unexpected PowerShell output/);
    expect(() => parseWindowsCaptureReport('{"left":0,"top":0,"screenWidth":0}')).toThrow(/no usable screen size/);
  });

  it("keeps one spelling of a case-insensitive Windows variable", () => {
    const env = desktopChildEnv({ PATH: "a", Path: "a", SystemRoot: "C:\\Windows", SYSTEMROOT: "C:\\Windows" }, "win32");
    expect(Object.keys(env).filter((key) => key.toUpperCase() === "PATH")).toHaveLength(1);
    expect(Object.keys(env).filter((key) => key.toUpperCase() === "SYSTEMROOT")).toHaveLength(1);
  });

  it("asks, captures the virtual screen and remembers its geometry", async () => {
    const host = desktopHost({ platform: "win32", env: WINDOWS_ENV, answers: { "powershell.exe": { stdout: WINDOWS_REPORT } } });
    const result = await host.tool.run({}, screenCtx());
    expect(result.status).toBe("ok");
    expect(host.calls.map((call) => call.command)).toEqual(["powershell.exe"]);
    expect(host.prompts).toHaveLength(1);
    expect(host.prompts[0]).toMatchObject({ tool: "os.screen.capture", category: "screen_capture" });
    expect(String(host.prompts[0]!.preview)).toContain("whole screen");
    const path = host.calls[0]!.env?.[WINDOWS_CAPTURE_OUT_ENV];
    expect(path).toMatch(/atomic-agent-screens[\\/]s1[\\/]screen-20261025-142233-417\.png$/);
    expect(result.details).toMatchObject({ path, imageWidth: 1280, imageHeight: 411, originX: -1920, originY: 0, captureTool: "powershell" });
    expect(host.geometry.get("s1")?.scale).toBeCloseTo(1280 / 4480, 6);
    expect(result.summary).toContain("vision.describe");
    expect(result.summary).toContain("macOS-only");
  });

  it("takes no picture when the screenshot is not approved", async () => {
    const host = desktopHost({ platform: "win32", env: WINDOWS_ENV });
    host.deny();
    await expect(host.tool.run({}, screenCtx())).rejects.toBeInstanceOf(ApprovalDeniedError);
    expect(host.calls).toEqual([]);
  });

  it("explains a failed capture (locked screen, UAC, no desktop)", async () => {
    const host = desktopHost({
      platform: "win32",
      env: WINDOWS_ENV,
      answers: { "powershell.exe": { exitCode: 1, stderr: "Exception calling \"CopyFromScreen\": The handle is invalid" } },
    });
    const result = await host.tool.run({}, screenCtx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("The handle is invalid");
    expect(result.summary).toContain("locked");
    expect(result.details.reason).toBe("capture-failed");
  });

  it("refuses a picture over the size limit", async () => {
    const host = desktopHost({
      platform: "win32",
      env: WINDOWS_ENV,
      answers: { "powershell.exe": { stdout: WINDOWS_REPORT } },
      fileSize: DESKTOP_CAPTURE_MAX_BYTES + 1,
    });
    const result = await host.tool.run({}, screenCtx());
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("too-large");
    expect(host.geometry.get("s1")).toBeUndefined();
  });

  it("refuses a region or a window off macOS without running anything", async () => {
    const host = desktopHost({ platform: "win32", env: WINDOWS_ENV });
    for (const args of [{ x: 0, y: 0, width: 10, height: 10 }, { app: "Notepad" }]) {
      const result = await host.tool.run(args, screenCtx());
      expect(result.status).toBe("error");
      expect(result.summary).toContain("whole screen only");
    }
    expect(host.calls).toEqual([]);
    expect(host.prompts).toEqual([]);
  });
});

describe("Linux capture", () => {
  it("tells Wayland, X11 and no display apart and picks candidates for each", () => {
    expect(linuxSessionKind(WAYLAND_ENV)).toBe("wayland");
    expect(linuxSessionKind({ XDG_SESSION_TYPE: "wayland" })).toBe("wayland");
    expect(linuxSessionKind(X11_ENV)).toBe("x11");
    expect(linuxSessionKind({})).toBe("none");
    expect(linuxCaptureCandidates("wayland")).toEqual(["grim", "gnome-screenshot", "spectacle"]);
    expect(linuxCaptureCandidates("x11")).toEqual(["gnome-screenshot", "spectacle", "scrot", "import"]);
    expect(linuxCaptureCandidates("none")).toEqual([]);
  });

  it("builds a fixed argv per tool with the path as the only variable", () => {
    const path = "/tmp/t/atomic-agent-screens/s1/screen.png";
    expect(linuxCaptureArgs("grim", path)).toEqual(["-t", "png", path]);
    expect(linuxCaptureArgs("gnome-screenshot", path)).toEqual(["-f", path]);
    expect(linuxCaptureArgs("spectacle", path)).toEqual(["-b", "-n", "-f", "-o", path]);
    expect(linuxCaptureArgs("scrot", path)).toEqual([path]);
    expect(linuxCaptureArgs("import", path)).toEqual(["-window", "root", path]);
  });

  it("reads the size from a PNG header and rejects anything else", () => {
    expect(parsePngSize(pngHead(3840, 2160))).toEqual({ width: 3840, height: 2160 });
    expect(parsePngSize(new Uint8Array(24))).toBeNull();
    expect(parsePngSize(pngHead(0, 10))).toBeNull();
    expect(parsePngSize(new Uint8Array())).toBeNull();
  });

  it("detects tools with one constant sh loop, then captures with the first one on X11", async () => {
    const host = desktopHost({
      platform: "linux",
      env: X11_ENV,
      answers: { sh: which("scrot", "import") },
      heads: [pngHead(1280, 720)],
    });
    const result = await host.tool.run({}, screenCtx());
    expect(result.status).toBe("ok");
    expect(host.calls[0]).toMatchObject({
      command: "sh",
      args: ["-c", LINUX_WHICH_SCRIPT, "sh", "gnome-screenshot", "spectacle", "scrot", "import", "magick", "convert"],
    });
    expect(host.calls[1]!.command).toBe("scrot");
    expect(host.calls[1]!.args[0]).toMatch(/atomic-agent-screens\/s1\/screen-20261025-142233-417\.png$/);
    expect(host.calls).toHaveLength(2);
    expect(host.calls[1]!.env?.DISPLAY).toBe(":0");
    expect(host.calls[1]!.env?.GITHUB_TOKEN).toBeUndefined();
    expect(String(host.prompts[0]!.preview)).toContain("taken with: scrot");
    expect(result.details).toMatchObject({ imageWidth: 1280, imageHeight: 720, captureTool: "scrot", originX: 0, originY: 0 });
    expect(host.geometry.get("s1")?.scale).toBe(1);
  });

  it("prefers grim on Wayland and leaves the X11 tools out", async () => {
    const host = desktopHost({
      platform: "linux",
      env: WAYLAND_ENV,
      answers: { sh: which("grim", "scrot") },
      heads: [pngHead(1920, 1080), pngHead(1280, 720)],
    });
    await host.tool.run({}, screenCtx());
    expect(host.calls[0]!.args.slice(3)).toEqual(["grim", "gnome-screenshot", "spectacle", "magick", "convert"]);
    expect(host.calls[1]!.command).toBe("grim");
  });

  it("falls back to the next available tool when the first produces nothing", async () => {
    const host = desktopHost({
      platform: "linux",
      env: WAYLAND_ENV,
      answers: {
        sh: which("grim", "spectacle"),
        grim: { exitCode: 1, stderr: "compositor doesn't support wlr-screencopy-unstable-v1" },
      },
      heads: [pngHead(1280, 800)],
    });
    const result = await host.tool.run({}, screenCtx());
    expect(result.status).toBe("ok");
    expect(host.calls.map((call) => call.command)).toEqual(["sh", "grim", "spectacle"]);
    expect(result.details.captureTool).toBe("spectacle");
  });

  it("downscales a large picture with ImageMagick and maps pixels to the full screen", async () => {
    const host = desktopHost({
      platform: "linux",
      env: X11_ENV,
      answers: { sh: which("import", "convert") },
      heads: [pngHead(3840, 2160), pngHead(1280, 720)],
    });
    const result = await host.tool.run({}, screenCtx());
    expect(result.status).toBe("ok");
    expect(host.calls[2]).toMatchObject({ command: "convert" });
    expect(host.calls[2]!.args.slice(1, 3)).toEqual(["-resize", "1280x1280>"]);
    expect(result.details).toMatchObject({ imageWidth: 1280, imageHeight: 720, screenWidth: 3840, screenHeight: 2160 });
    expect(host.geometry.get("s1")?.scale).toBeCloseTo(1280 / 3840, 6);
  });

  it("keeps a large picture full size, with a note, when nothing can shrink it", async () => {
    const host = desktopHost({
      platform: "linux",
      env: X11_ENV,
      answers: { sh: which("scrot") },
      heads: [pngHead(3840, 2160)],
    });
    const result = await host.tool.run({}, screenCtx());
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("full size");
    expect(host.calls.map((call) => call.command)).toEqual(["sh", "scrot"]);
  });

  it("lists what to install, without asking, when no tool is found", async () => {
    const host = desktopHost({ platform: "linux", env: X11_ENV, answers: { sh: which() } });
    const result = await host.tool.run({}, screenCtx());
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("no-capture-tool");
    expect(result.summary).toContain("scrot");
    expect(result.summary).toContain("gnome-screenshot");
    expect(result.summary).toContain("GNOME on Wayland");
    expect(host.prompts).toEqual([]);
    expect(host.calls.map((call) => call.command)).toEqual(["sh"]);
  });

  it("says there is no display when neither WAYLAND_DISPLAY nor DISPLAY is set", async () => {
    const host = desktopHost({ platform: "linux", env: { PATH: "/usr/bin" } });
    const result = await host.tool.run({}, screenCtx());
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("no-display");
    expect(host.calls).toEqual([]);
    expect(linuxMissingToolMessage("none")).toContain("SSH");
  });

  it("reports every tool it tried when all of them fail", async () => {
    const host = desktopHost({
      platform: "linux",
      env: WAYLAND_ENV,
      answers: { sh: which("grim", "gnome-screenshot"), grim: { exitCode: 1, stderr: "no wlr-screencopy" }, "gnome-screenshot": { exitCode: 1 } },
    });
    const result = await host.tool.run({}, screenCtx());
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("capture-failed");
    expect(result.summary).toContain("Tried grim, gnome-screenshot");
  });
});

describe("off-mac message for the control tools", () => {
  it("says capture works here and control is macOS-only", () => {
    for (const os of ["win32", "linux"] as const) {
      const message = macOnlyMessage("os.screen.click", os);
      expect(message).toContain("os.screen.capture works here");
      expect(message).toContain("macOS-only");
      expect(message).toContain("ATO-527");
    }
    expect(macOnlyMessage("os.screen.click", "freebsd")).toContain("macOS only");
  });
});

describe("ensurePrivateDir (shared /tmp on Linux)", () => {
  function fakeFs(entries: Record<string, { dir?: boolean; link?: boolean; uid?: number }>, uid: number | null = 1000) {
    const chmods: Array<[string, number]> = [];
    const mkdirs: Array<[string, number]> = [];
    const fs: PrivateDirFs = {
      mkdir: async (path, options) => {
        mkdirs.push([path, options.mode]);
      },
      lstat: async (path) => {
        const e = entries[path] ?? { dir: true, uid: 1000 };
        return {
          isDirectory: () => e.dir ?? true,
          isSymbolicLink: () => e.link ?? false,
          uid: e.uid ?? 1000,
        };
      },
      chmod: async (path, mode) => {
        chmods.push([path, mode]);
      },
      uid: () => uid,
    };
    return { fs, chmods, mkdirs };
  }

  const dir = "/tmp/atomic-agent-screens/s1";

  it("creates 0700 and tightens both levels", async () => {
    const { fs, chmods, mkdirs } = fakeFs({});
    await ensurePrivateDir(dir, fs);
    expect(mkdirs).toEqual([[dir, 0o700]]);
    expect(chmods).toEqual([
      ["/tmp/atomic-agent-screens", 0o700],
      [dir, 0o700],
    ]);
  });

  it("refuses a parent another user created", async () => {
    const { fs } = fakeFs({ "/tmp/atomic-agent-screens": { uid: 1001 } });
    await expect(ensurePrivateDir(dir, fs)).rejects.toThrow(/another user/);
  });

  it("refuses a symlink in place of the folder", async () => {
    const { fs } = fakeFs({ [dir]: { link: true } });
    await expect(ensurePrivateDir(dir, fs)).rejects.toThrow(/not a plain folder/);
  });

  it("only checks for symlinks where there is no uid (Windows)", async () => {
    const { fs, chmods } = fakeFs({ "/tmp/atomic-agent-screens": { uid: 5 } }, null);
    await ensurePrivateDir(dir, fs);
    expect(chmods).toEqual([]);
  });
});
