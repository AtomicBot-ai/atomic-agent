import { describe, expect, it } from "vitest";
import type { ApprovalGate } from "../../../approval/approval-gate.js";
import { ApprovalDeniedError } from "../../../approval/dangerous-tool.js";
import { buildOsScreenCaptureTool, parseRegion, screencaptureArgs } from "./screen-capture.js";
import { ScreenGeometryStore } from "./screen-geometry.js";
import { parseScreenProbe } from "./screen-host.js";
import { fakeHost, screenCtx, type FakeHostOptions } from "./screen-host.fixture.js";

function capture(host: FakeHostOptions = {}, approved = true) {
  const fake = fakeHost(host);
  const geometry = new ScreenGeometryStore();
  const prompts: Array<Record<string, unknown>> = [];
  const request = async (req: Record<string, unknown>) => {
    prompts.push(req);
    return approved ? { approved: true } : { approved: false, reason: "no" };
  };
  const approvals = { request } as unknown as ApprovalGate;
  const tool = buildOsScreenCaptureTool({ approvals, approvalRequired: true, deps: fake.deps, geometry });
  return { fake, geometry, tool, prompts };
}

describe("os.screen.capture", () => {
  it("captures silently as JPEG, downscales a Retina shot and remembers the scale", async () => {
    const { fake, geometry, tool } = capture({
      pixelSizes: [{ width: 2880, height: 1800 }, { width: 1280, height: 800 }],
    });
    const result = await tool.run({}, screenCtx());
    expect(result.status).toBe("ok");
    const path = "/tmp/t/atomic-agent-screens/s1/screen-20261025-142233-417.jpg";
    expect(fake.calls.map((call) => [call.command, ...call.args.filter((arg) => !arg.includes("ObjC"))])).toEqual([
      ["osascript", "-l", "JavaScript", "-e"],
      ["screencapture", "-x", "-t", "jpg", path],
      ["sips", "-g", "pixelWidth", "-g", "pixelHeight", path],
      ["sips", "-Z", "1280", path],
      ["sips", "-g", "pixelWidth", "-g", "pixelHeight", path],
    ]);
    expect(result.details).toMatchObject({ path, imageWidth: 1280, imageHeight: 800, originX: 0, originY: 0 });
    expect(result.details.scale).toBeCloseTo(1280 / 1440, 6);
    expect(geometry.get("s1")?.scale).toBeCloseTo(1280 / 1440, 6);
    expect(result.summary).toContain("vision.describe");
    expect(result.summary).toContain("atomic-agent-screens/s1/screen-20261025-142233-417.jpg");
  });

  it("asks as screen_capture after the probe and before anything is captured", async () => {
    // A browser in front is fine: screen control only looks at browsers, it never clicks or types there.
    const { prompts, tool } = capture({ frontmost: { name: "Safari", bundleId: "com.apple.Safari" } });
    await tool.run({}, screenCtx());
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ tool: "os.screen.capture", category: "screen_capture" });
    expect(String(prompts[0]!.preview)).toContain("frontmost app: Safari");
  });

  it("takes no picture when the screenshot is not approved", async () => {
    const { fake, tool } = capture({}, false);
    await expect(tool.run({}, screenCtx())).rejects.toBeInstanceOf(ApprovalDeniedError);
    expect(fake.calls.map((call) => call.command)).toEqual(["osascript"]);
  });

  it("keeps a small region at full resolution and records its origin", async () => {
    const { fake, geometry, tool } = capture({ pixelSizes: [{ width: 800, height: 600 }] });
    const result = await tool.run({ x: 100, y: 50, width: 400, height: 300 }, screenCtx());
    expect(result.status).toBe("ok");
    expect(fake.calls.some((call) => call.command === "sips" && call.args[0] === "-Z")).toBe(false);
    expect(fake.calls[1]?.args).toContain("100,50,400,300");
    expect(geometry.get("s1")).toEqual({ originX: 100, originY: 50, scale: 2, imageWidth: 800, imageHeight: 600 });
  });

  it("stops with an actionable message when Screen Recording is not granted", async () => {
    const { fake, tool } = capture({ screenRecording: false, env: { TERM_PROGRAM: "iTerm.app" } });
    const result = await tool.run({}, screenCtx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("Screen Recording");
    expect(result.summary).toContain("iTerm");
    expect(result.summary).toContain("Privacy & Security");
    expect(result.details.reason).toBe("screen-recording-permission");
    expect(fake.calls.map((call) => call.command)).toEqual(["osascript"]);
  });

  it("treats a failed or empty capture as a permission problem, not a picture", async () => {
    const failed = await capture({ screencaptureExit: 1 }).tool.run({}, screenCtx());
    expect(failed.status).toBe("error");
    expect(failed.details.reason).toBe("capture-failed");
    const empty = await capture({ fileSize: 0 }).tool.run({}, screenCtx());
    expect(empty.status).toBe("error");
    expect(empty.summary).toContain("Screen Recording");
  });

  it("rejects a region that does not fit the main screen", async () => {
    const { tool } = capture();
    const result = await tool.run({ region: { x: 1400, y: 0, width: 100, height: 100 } }, screenCtx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("does not fit");
  });

  it("answers macOS-only elsewhere without running anything", async () => {
    const { fake, tool } = capture({ platform: "win32" });
    const result = await tool.run({}, screenCtx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("macOS only");
    expect(fake.calls).toEqual([]);
  });
});

describe("capture helpers", () => {
  it("builds screencapture argv with and without a region", () => {
    expect(screencaptureArgs("/a.jpg")).toEqual(["-x", "-t", "jpg", "/a.jpg"]);
    expect(screencaptureArgs("/a.jpg", { x: 1, y: 2, width: 3, height: 4 })).toEqual(["-x", "-t", "jpg", "-R", "1,2,3,4", "/a.jpg"]);
  });

  it("validates regions", () => {
    expect(parseRegion(undefined)).toBeUndefined();
    expect(parseRegion(null)).toBeUndefined();
    expect(() => parseRegion({ x: 0, y: 0, width: 0, height: 5 })).toThrow(/width, height > 0/);
    expect(() => parseRegion({ x: "1", y: 0, width: 1, height: 1 })).toThrow(/numeric/);
    expect(() => parseRegion([1, 2, 3, 4])).toThrow(/object/);
  });

  it("parses a probe and refuses junk", () => {
    const probe = parseScreenProbe(
      JSON.stringify({ accessibility: true, screenRecording: null, frontmost: { name: "Finder", bundleId: "com.apple.finder" }, screen: { width: 1512, height: 982, scale: 2 }, done: false }),
    );
    expect(probe).toEqual({
      accessibility: true,
      screenRecording: null,
      frontmost: { name: "Finder", bundleId: "com.apple.finder" },
      screen: { width: 1512, height: 982, scale: 2 },
      done: false,
    });
    expect(() => parseScreenProbe("execution error: -1743")).toThrow(/unexpected osascript output/);
    expect(() => parseScreenProbe("{}")).toThrow(/no primary display/);
  });
});
