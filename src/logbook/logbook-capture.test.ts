import { describe, expect, it, vi } from "vitest";

import type { VisionRequest } from "../llm/provider/llm-provider.js";
import type { ScreenCommandResult, ScreenDeps } from "../tools/os/screen/screen-host.js";
import { captureLogbookFrame, cleanObservation, LOGBOOK_TEXT_MAX } from "./logbook-capture.js";
import type { LogbookVisionProvider } from "./logbook-local-vision.js";

type App = { name: string; bundleId: string } | null;

/** A host whose probes report `fronts` in order (the last repeats); nothing real is touched. */
function host(fronts: App[], options: { platform?: NodeJS.Platform; screenRecording?: boolean; shotExit?: number } = {}) {
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
    capabilities: { vision: true, visionSource: "mmproj" },
    describeImage: vi.fn(async (request: VisionRequest) => ({ text: await answer(request), durationMs: 5 })),
  };
}

const TEXTEDIT = { name: "TextEdit", bundleId: "com.apple.TextEdit" };
const ONEPASSWORD = { name: "1Password", bundleId: "com.1password.1password" };
const signal = () => new AbortController().signal;

describe("captureLogbookFrame", () => {
  it("describes the frame with the local model, keeps the text and deletes the picture", async () => {
    const h = host([TEXTEDIT]);
    const p = provider(async () => "  Writing the\nlogbook README in TextEdit. ");
    const outcome = await captureLogbookFrame(h.deps, p, [], signal());
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
    const outcome = await captureLogbookFrame(h.deps, p, [], signal());
    expect(outcome.kind).toBe("skipped");
    expect(h.commands.some((c) => c.startsWith("screencapture"))).toBe(false);
    expect(p.describeImage).not.toHaveBeenCalled();
  });

  it("throws the picture away undescribed when a protected app came to the front during the shot", async () => {
    const h = host([TEXTEDIT, ONEPASSWORD]);
    const p = provider(async () => "x");
    const outcome = await captureLogbookFrame(h.deps, p, [], signal());
    expect(outcome.kind).toBe("skipped");
    expect(p.describeImage).not.toHaveBeenCalled();
    expect(h.removed).toHaveLength(1);
  });

  it("skips an app the person excluded", async () => {
    const h = host([TEXTEDIT]);
    const outcome = await captureLogbookFrame(h.deps, provider(async () => "x"), ["TextEdit"], signal());
    expect(outcome).toEqual({ kind: "skipped", reason: "TextEdit is on your excluded list" });
  });

  it("deletes the picture when the model call fails", async () => {
    const h = host([TEXTEDIT]);
    const outcome = await captureLogbookFrame(h.deps, provider(async () => { throw new Error("server down"); }), [], signal());
    expect(outcome).toEqual({ kind: "error", reason: "server down" });
    expect(h.removed).toHaveLength(1);
  });

  it("reports a missing Screen Recording permission without a shot", async () => {
    const h = host([TEXTEDIT], { screenRecording: false });
    const outcome = await captureLogbookFrame(h.deps, provider(async () => "x"), [], signal());
    expect(outcome.kind).toBe("error");
    expect(h.commands.some((c) => c.startsWith("screencapture"))).toBe(false);
  });

  it("does nothing off macOS", async () => {
    const h = host([TEXTEDIT], { platform: "linux" });
    const outcome = await captureLogbookFrame(h.deps, provider(async () => "x"), [], signal());
    expect(outcome.kind).toBe("skipped");
    expect(h.commands).toEqual([]);
  });
});

describe("cleanObservation", () => {
  it("flattens, masks secrets and caps the text", () => {
    expect(cleanObservation("a\n\n b")).toBe("a b");
    expect(cleanObservation(`key sk-or-v1-${"a".repeat(48)} on screen`)).not.toContain("a".repeat(48));
    expect(cleanObservation("x".repeat(LOGBOOK_TEXT_MAX + 50))).toHaveLength(LOGBOOK_TEXT_MAX);
  });
});
