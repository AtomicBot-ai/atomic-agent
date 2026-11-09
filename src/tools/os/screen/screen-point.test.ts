import { describe, expect, it } from "vitest";
import { ToolRegistry, type ToolContext } from "../../tool-registry.js";
import { captureGeometry, ScreenGeometryStore } from "./screen-geometry.js";
import { registerOsScreenTools } from "./index.js";
import { CAPTURE_NEEDS_OVERLAY_MESSAGE } from "./screen-capture.js";
import { claimScreenOverlay, screenOverlayAvailable } from "./screen-overlay-hosts.js";
import {
  buildOsScreenPointTool,
  NO_OVERLAY_MESSAGE,
  SCREEN_POINT_MAX_SECONDS,
  type ScreenMarksPayload,
} from "./screen-point.js";

const ctx = (sessionId = "s-1"): ToolContext => ({
  workingDir: "/tmp",
  sessionId,
  stepIndex: 0,
  signal: new AbortController().signal,
});

/** A Retina display: 1440x900 points captured at 2880x1800 and downscaled to 1280x800. */
const retina = captureGeometry({ x: 0, y: 0, width: 1440, height: 900 }, { width: 1280, height: 800 });

function setup(options: { overlay?: boolean; capture?: boolean; platform?: NodeJS.Platform } = {}) {
  const geometry = new ScreenGeometryStore();
  if (options.capture !== false) geometry.set("s-1", retina);
  const tool = buildOsScreenPointTool({
    geometry,
    platform: options.platform ?? "darwin",
    overlayAvailable: () => options.overlay !== false,
  });
  return { tool, geometry };
}

const marksOf = (details: Record<string, unknown> | undefined) =>
  (details?.screenMarks as ScreenMarksPayload | undefined)?.marks;

describe("os.screen.point (ATO-1018)", () => {
  it("maps image pixels of the last capture to screen points, sizes by the scale (Retina)", async () => {
    const { tool } = setup();
    const out = await tool.run(
      {
        marks: [
          { kind: "arrow", x: 640, y: 400, text: "Save", step: 1 },
          { kind: "box", x: 128, y: 80, width: 256, height: 64, step: 2 },
        ],
      },
      ctx(),
    );
    expect(out.status).toBe("ok");
    expect(marksOf(out.details)).toEqual([
      { kind: "arrow", x: 720, y: 450, text: "Save", step: 1 },
      { kind: "box", x: 144, y: 90, width: 288, height: 72, step: 2 },
    ]);
    expect((out.details?.screenMarks as ScreenMarksPayload).seconds).toBe(20);
    expect(out.summary).toContain("Nothing was clicked or typed");
  });

  it("adds a region capture's origin", async () => {
    const { tool, geometry } = setup();
    geometry.set("s-1", captureGeometry({ x: 200, y: 100, width: 400, height: 300 }, { width: 800, height: 600 }));
    const out = await tool.run({ marks: [{ kind: "label", x: 100, y: 50, text: "here" }] }, ctx());
    expect(marksOf(out.details)).toEqual([{ kind: "label", x: 250, y: 125, text: "here" }]);
  });

  it("takes global screen points as they are, a second display's negative ones included", async () => {
    const { tool } = setup({ capture: false });
    const out = await tool.run(
      { coords: "points", marks: [{ kind: "arrow", x: -1200, y: 300 }, { kind: "arrow", x: 2100.5, y: -40 }] },
      ctx(),
    );
    expect(out.status).toBe("ok");
    expect(marksOf(out.details)).toEqual([
      { kind: "arrow", x: -1200, y: 300 },
      { kind: "arrow", x: 2100.5, y: -40 },
    ]);
  });

  it("asks for a capture before reading image pixels", async () => {
    const { tool } = setup({ capture: false });
    const out = await tool.run({ marks: [{ kind: "arrow", x: 10, y: 10 }] }, ctx());
    expect(out.status).toBe("error");
    expect(out.summary).toMatch(/os\.screen\.capture/);
  });

  it("refuses a pixel outside the image it saw", async () => {
    const { tool } = setup();
    const out = await tool.run({ marks: [{ kind: "box", x: 1200, y: 700, width: 200, height: 50 }] }, ctx());
    expect(out.status).toBe("error");
    expect(out.summary).toMatch(/outside the last capture \(1280x800 px\)/);
  });

  it("validates marks: kinds, box sizes, label text, steps, count", async () => {
    const { tool } = setup();
    const bad = async (marks: unknown) => (await tool.run({ marks }, ctx())).summary;
    expect(await bad([])).toMatch(/at least one/);
    expect(await bad([{ kind: "circle", x: 1, y: 1 }])).toMatch(/"arrow", "box" or "label"/);
    expect(await bad([{ kind: "box", x: 1, y: 1 }])).toMatch(/width/);
    expect(await bad([{ kind: "label", x: 1, y: 1 }])).toMatch(/needs `text`/);
    expect(await bad([{ kind: "arrow", x: 1, y: 1, step: 0 }])).toMatch(/step/);
    expect(await bad([{ kind: "arrow", x: 1, y: 1, text: "x".repeat(61) }])).toMatch(/60/);
    expect(await bad(Array.from({ length: 9 }, () => ({ kind: "arrow", x: 1, y: 1 })))).toMatch(/at most 8/);
    expect(await bad([{ kind: "arrow", x: "1", y: 1 }])).toMatch(/x must be a number/);
  });

  it("clamps how long the marks stay", async () => {
    const { tool } = setup();
    const out = await tool.run({ marks: [{ kind: "arrow", x: 1, y: 1 }], seconds: 100_000 }, ctx());
    expect((out.details?.screenMarks as ScreenMarksPayload).seconds).toBe(SCREEN_POINT_MAX_SECONDS);
    const short = await tool.run({ marks: [{ kind: "arrow", x: 1, y: 1 }], seconds: 0 }, ctx());
    expect((short.details?.screenMarks as ScreenMarksPayload).seconds).toBe(3);
  });

  it("never clicks or types: input-shaped arguments are refused and draw nothing", async () => {
    const { tool } = setup();
    for (const args of [
      { marks: [{ kind: "arrow", x: 1, y: 1 }], click: true },
      { marks: [{ kind: "arrow", x: 1, y: 1 }], double: true },
      { marks: [{ kind: "arrow", x: 1, y: 1 }], button: "left" },
      { marks: [{ kind: "arrow", x: 1, y: 1 }], type: "hello" },
      { marks: [{ kind: "arrow", x: 1, y: 1 }], keys: "return" },
      { marks: [{ kind: "arrow", x: 1, y: 1 }], action: "click" },
      { marks: [{ kind: "arrow", x: 1, y: 1, click: true }] },
    ]) {
      const out = await tool.run(args, ctx());
      expect(out.status, JSON.stringify(args)).toBe("error");
      expect(out.summary).toMatch(/only draws marks; it never clicks, types or presses keys/);
      expect(out.details).not.toHaveProperty("screenMarks");
    }
  });

  it("says marks need the desktop app when no overlay host draws for the session", async () => {
    const { tool } = setup({ overlay: false });
    const out = await tool.run({ marks: [{ kind: "arrow", x: 1, y: 1 }] }, ctx());
    expect(out.status).toBe("error");
    expect(out.summary).toBe(NO_OVERLAY_MESSAGE);
    expect(out.details).toMatchObject({ reason: "no-overlay", retryable: false });
  });

  it("is macOS only", async () => {
    const { tool } = setup({ platform: "linux" });
    expect((await tool.run({ marks: [{ kind: "arrow", x: 1, y: 1 }] }, ctx())).summary).toMatch(/macOS only/);
  });

  it("counts overlay claims per session until each stream releases its own", () => {
    expect(screenOverlayAvailable("s-claim")).toBe(false);
    const first = claimScreenOverlay("s-claim");
    const second = claimScreenOverlay("s-claim");
    first();
    first();
    expect(screenOverlayAvailable("s-claim")).toBe(true);
    second();
    expect(screenOverlayAvailable("s-claim")).toBe(false);
  });
});

describe("registering os.screen.point", () => {
  const dangerous = { approvals: undefined as never, approvalRequired: false };
  const names = (options: { enabled: boolean; point?: boolean; platform?: NodeJS.Platform }) => {
    const registry = new ToolRegistry();
    registerOsScreenTools(registry, { ...dangerous, platform: "darwin", ...options });
    return registry.list().map((t) => t.name);
  };

  it("comes with capture only (no click, type or key) without screen control", () => {
    expect(names({ enabled: false, point: true })).toEqual(["os.screen.capture", "os.screen.point"]);
  });

  it("joins the control tools when both are on, and stays off when pointing is off", () => {
    expect(names({ enabled: true, point: true })).toEqual([
      "os.screen.capture",
      "os.screen.click",
      "os.screen.type",
      "os.screen.key",
      "os.screen.point",
    ]);
    expect(names({ enabled: true, point: false })).not.toContain("os.screen.point");
    expect(names({ enabled: false, point: false })).toEqual([]);
    expect(names({ enabled: false, point: true, platform: "linux" })).toEqual([]);
  });

  it("without screen control, capture refuses a session whose host draws no marks (TUI, channel, task)", async () => {
    const registry = new ToolRegistry();
    registerOsScreenTools(registry, {
      ...dangerous,
      enabled: false,
      point: true,
      platform: "darwin",
      overlayAvailable: () => false,
    });
    const out = await registry.get("os.screen.capture").run({}, ctx());
    expect(out.status).toBe("error");
    expect(out.summary).toBe(CAPTURE_NEEDS_OVERLAY_MESSAGE);
    expect(out.details).toMatchObject({ reason: "no-overlay" });
  });

  it("the registered tool is read-only", () => {
    const registry = new ToolRegistry();
    registerOsScreenTools(registry, { ...dangerous, enabled: false, point: true, platform: "darwin" });
    expect(registry.list().find((t) => t.name === "os.screen.point")?.readonly).toBe(true);
  });
});
