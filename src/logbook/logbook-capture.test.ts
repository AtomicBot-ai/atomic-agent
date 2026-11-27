import { describe, expect, it, vi } from "vitest";

import type { ProviderCapabilities, VisionRequest } from "../llm/provider/llm-provider.js";
import type { ScreenCommandResult, ScreenDeps } from "../tools/os/screen/screen-host.js";
import { captureLogbookFrame, cleanObservation, IDLE_REASON, LOGBOOK_TEXT_MAX, type LogbookCaptureOptions } from "./logbook-capture.js";
import type { LogbookVisionProvider } from "./logbook-local-vision.js";

type App = { name: string; bundleId: string } | null;

/** A host whose probes report `fronts` in order (the last repeats); nothing real is touched. */
function host(fronts: App[], options: { platform?: NodeJS.Platform; screenRecording?: boolean; shotExit?: number; idleNs?: number } = {}) {
  const queue = [...fronts];
  const commands: string[] = [];
  const run = async (command: string, args: readonly string[]): Promise<ScreenCommandResult> => {
    commands.push(`${command} ${args.join(" ")}`);
    if (command === "osascript") {
      const front = queue.length > 1 ? queue.shift()! : queue[0]!;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ accessibility: true, screenRecording: options.screenRecording ?? true, frontmost: front, screen: { width: 1440, height: 900, scale: 2 }, done: false }),
        stderr: "",
      };
    }
    if (command === "ioreg") return { exitCode: 0, stdout: options.idleNs === undefined ? "" : `"HIDIdleTime" = ${options.idleNs}`, stderr: "" };
    if (command === "screencapture") return { exitCode: options.shotExit ?? 0, stdout: "", stderr: options.shotExit ? "no display" : "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const screen: ScreenDeps = {
    run,
    platform: options.platform ?? "darwin",
    env: { PATH: "/usr/bin" },
    fileSize: async () => 1000,
    readHead: async () => new Uint8Array(),
    ensureDir: async () => undefined,
    writeText: async () => undefined,
    now: () => new Date(2026, 10, 27, 14, 5, 0),
    tmpDir: "/tmp/t",
  };
  const removed: string[] = [];
  const deps = {
    screen,
    framesDir: "/state/logbook/frames",
    readFile: async () => new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]),
    removeFile: async (path: string) => {
      removed.push(path);
    },
    workingDir: "/state",
  };
  return { deps, commands, removed };
}

function provider(answer: (request: VisionRequest) => Promise<string>): LogbookVisionProvider & { describeImage: ReturnType<typeof vi.fn> } {
  return {
    id: "local-llama",
    name: "llama-server",
    capabilities: { vision: true, visionSource: "mmproj" } as ProviderCapabilities,
    describeImage: vi.fn(async (request: VisionRequest) => ({ text: await answer(request), durationMs: 5 })),
  };
}

const TEXTEDIT = { name: "TextEdit", bundleId: "com.apple.TextEdit" };
const ONEPASSWORD = { name: "1Password", bundleId: "com.1password.1password" };
const signal = () => new AbortController().signal;
const OPTS: LogbookCaptureOptions = { excludeApps: [], titleOnlyApps: [], idleSkipMs: null };

describe("captureLogbookFrame", () => {
  it("describes the frame with the local model, keeps the text and deletes the picture", async () => {
    const h = host([TEXTEDIT]);
    const p = provider(async () => "  Writing the\nlogbook README in TextEdit. ");
    const outcome = await captureLogbookFrame(h.deps, p, OPTS, signal());
    expect(outcome).toEqual({
      kind: "captured",
      entry: { at: new Date(2026, 10, 27, 14, 5, 0).toISOString(), app: "TextEdit", bundleId: "com.apple.TextEdit", text: "Writing the logbook README in TextEdit." },
    });
    expect(p.describeImage).toHaveBeenCalledTimes(1);
    const request = p.describeImage.mock.calls[0]![0] as VisionRequest;
    expect(request.images[0]!.mimeType).toBe("image/jpeg");
    expect(h.commands.some((c) => c.startsWith("screencapture -x -t jpg /state/logbook/frames/frame-"))).toBe(true);
    expect(h.removed).toHaveLength(1);
    expect(h.removed[0]).toMatch(/^\/state\/logbook\/frames\/frame-\d+\.jpg$/);
  });

  it("takes no screenshot while a protected app is in front", async () => {
    const h = host([ONEPASSWORD]);
    const p = provider(async () => "x");
    const outcome = await captureLogbookFrame(h.deps, p, OPTS, signal());
    expect(outcome.kind).toBe("skipped");
    expect(h.commands.some((c) => c.startsWith("screencapture"))).toBe(false);
    expect(p.describeImage).not.toHaveBeenCalled();
  });

  it("throws the picture away undescribed when a protected app came to the front during the shot", async () => {
    const h = host([TEXTEDIT, ONEPASSWORD]);
    const p = provider(async () => "x");
    const outcome = await captureLogbookFrame(h.deps, p, OPTS, signal());
    expect(outcome.kind).toBe("skipped");
    expect(p.describeImage).not.toHaveBeenCalled();
    expect(h.removed).toHaveLength(1);
  });

  it("skips an app the person excluded", async () => {
    const h = host([TEXTEDIT]);
    const outcome = await captureLogbookFrame(h.deps, provider(async () => "x"), { ...OPTS, excludeApps: ["TextEdit"] }, signal());
    expect(outcome).toEqual({ kind: "skipped", reason: "TextEdit is on your excluded list" });
  });

  it("deletes the picture when the model call fails", async () => {
    const h = host([TEXTEDIT]);
    const outcome = await captureLogbookFrame(h.deps, provider(async () => { throw new Error("server down"); }), OPTS, signal());
    expect(outcome).toEqual({ kind: "error", reason: "server down" });
    expect(h.removed).toHaveLength(1);
  });

  it("reports a missing Screen Recording permission without a shot", async () => {
    const h = host([TEXTEDIT], { screenRecording: false });
    const outcome = await captureLogbookFrame(h.deps, provider(async () => "x"), OPTS, signal());
    expect(outcome.kind).toBe("error");
    expect(h.commands.some((c) => c.startsWith("screencapture"))).toBe(false);
  });

  it("on Linux under Wayland takes no picture and says how to use it (ATO-2526)", async () => {
    const h = host([TEXTEDIT], { platform: "linux" });
    h.deps.screen.env = { PATH: "/usr/bin", WAYLAND_DISPLAY: "wayland-0" };
    const outcome = await captureLogbookFrame(h.deps, provider(async () => "x"), OPTS, signal());
    expect(outcome).toMatchObject({ kind: "skipped", reason: expect.stringMatching(/Wayland/) });
    expect(h.commands).toEqual([]);
  });

  it("notes only the window title for a title-only app: no screenshot, no model (ATO-2526)", async () => {
    const h = host([TEXTEDIT]);
    const p = provider(async () => "x");
    const outcome = await captureLogbookFrame(h.deps, p, { ...OPTS, titleOnlyApps: ["TextEdit"] }, signal());
    expect(outcome).toMatchObject({ kind: "captured", entry: { app: "TextEdit", text: expect.stringMatching(/^In TextEdit/) } });
    expect(h.commands.some((c) => c.startsWith("screencapture"))).toBe(false);
    expect(p.describeImage).not.toHaveBeenCalled();
  });

  it("skips the frame when nobody touched the computer for the whole idle time (ATO-2526)", async () => {
    const h = host([TEXTEDIT], { idleNs: 10 * 60 * 1e9 });
    const p = provider(async () => "x");
    const outcome = await captureLogbookFrame(h.deps, p, { ...OPTS, idleSkipMs: 5 * 60_000 }, signal());
    expect(outcome).toEqual({ kind: "skipped", reason: IDLE_REASON });
    expect(p.describeImage).not.toHaveBeenCalled();
  });
});

describe("captureLogbookFrame on Windows (ATO-2526)", () => {
  function winHost(front: { process: string; description: string; title: string; idleMs: number }, shotFails = false) {
    const commands: string[] = [];
    const screen: ScreenDeps = {
      run: async (command, args) => {
        commands.push(`${command} ${args.slice(0, 1).join(" ")}`);
        const script = Buffer.from(String(args[args.length - 1]), "base64").toString("utf16le");
        if (script.includes("GetForegroundWindow")) return { exitCode: 0, stdout: JSON.stringify(front), stderr: "" };
        if (shotFails) return { exitCode: 1, stdout: "", stderr: "locked" };
        return { exitCode: 0, stdout: JSON.stringify({ left: 0, top: 0, screenWidth: 1920, screenHeight: 1080, imageWidth: 1280, imageHeight: 720 }), stderr: "" };
      },
      platform: "win32",
      env: { PATH: "C:\\Windows" },
      fileSize: async () => 1000,
      readHead: async () => new Uint8Array(),
      ensureDir: async () => undefined,
      writeText: async () => undefined,
      now: () => new Date(2026, 10, 27, 14, 5, 0),
      tmpDir: "C:\\tmp",
    };
    const removed: string[] = [];
    const deps = { screen, framesDir: "C:\\state\\logbook\\frames", readFile: async () => new Uint8Array([0x89, 0x50]), removeFile: async (p: string) => void removed.push(p), workingDir: "C:\\state" };
    return { deps, commands, removed };
  }

  it("reads the foreground window and describes a PNG taken by the screen tools' PowerShell capture", async () => {
    const h = winHost({ process: "WINWORD", description: "Microsoft Word", title: "Report.docx", idleMs: 1_000 });
    const p = provider(async () => "Editing a report in Word.");
    const outcome = await captureLogbookFrame(h.deps, p, OPTS, signal());
    expect(outcome).toMatchObject({ kind: "captured", entry: { app: "Microsoft Word", bundleId: "winword", text: "Editing a report in Word." } });
    expect((p.describeImage.mock.calls[0]![0] as VisionRequest).images[0]!.mimeType).toBe("image/png");
    expect(h.removed[0]).toMatch(/frame-\d+\.png$/);
  });

  it("never photographs a password manager or the lock screen", async () => {
    for (const proc of ["KeePass", "LockApp", "consent"]) {
      const h = winHost({ process: proc, description: "", title: "", idleMs: 0 });
      const p = provider(async () => "x");
      const outcome = await captureLogbookFrame(h.deps, p, OPTS, signal());
      expect(outcome.kind).toBe("skipped");
      expect(p.describeImage).not.toHaveBeenCalled();
    }
  });
});

describe("cleanObservation"describe("cleanObservation", () => {
  it("flattens, masks secrets and caps the text", () => {
    expect(cleanObservation("a\n\n b")).toBe("a b");
    expect(cleanObservation(`key sk-or-v1-${"a".repeat(48)} on screen`)).not.toContain("a".repeat(48));
    expect(cleanObservation("x".repeat(LOGBOOK_TEXT_MAX + 50))).toHaveLength(LOGBOOK_TEXT_MAX);
  });
});
