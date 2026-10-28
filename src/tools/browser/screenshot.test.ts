import { describe, expect, it } from "vitest";
import { GATE_CTX, GateBackend, recordingGate } from "./browser-gate-test-helpers.js";
import { UserSiteApprovals } from "./user-profile-sites.js";
import { browserShotDir, buildBrowserScreenshotTool, type BrowserScreenshotDeps } from "./screenshot.js";
import {
  BROWSER_SHOT_MAX_BYTES,
  BROWSER_SHOT_MAX_SIDE,
  FULL_PAGE_MAX_CSS_HEIGHT,
  planShot,
} from "./screenshot-geometry.js";
import type { BrowserDomainPolicy } from "./browser-domain-policy.js";

/** `browser.screenshot` (ATO-515) against a fake backend and an in-memory disk. */

function memoryDisk() {
  const files = new Map<string, Buffer>();
  const deps: BrowserScreenshotDeps = {
    tmpDir: () => "/tmp-test",
    ensureDir: async () => undefined,
    writeFile: async (path, data) => {
      files.set(path, data);
    },
    now: () => new Date("2026-10-28T10:00:00.123Z"),
  };
  return { files, deps };
}

const BLOCK_BANK: BrowserDomainPolicy = { blockedDomains: ["bank.example"], allowedDomains: [] };

describe("browser.screenshot", () => {
  it("saves a viewport JPEG under the temp folder and says how to look at it", async () => {
    const backend = new GateBackend();
    const { files, deps } = memoryDisk();
    const result = await buildBrowserScreenshotTool(backend, undefined, deps).run({}, GATE_CTX);
    expect(result.status).toBe("ok");
    const path = (result.details as { path: string }).path;
    expect(path.startsWith(browserShotDir("/tmp-test", GATE_CTX.sessionId))).toBe(true);
    expect(path.endsWith(".jpg")).toBe(true);
    expect(files.get(path)?.length).toBe(1_000);
    expect(result.details).toMatchObject({ mime: "image/jpeg", imageWidth: BROWSER_SHOT_MAX_SIDE, url: backend.url });
    expect(result.summary).toContain("vision.describe");
    expect(result.summary).toContain("reply.attachments");
    expect(backend.shots[0]).toEqual({ maxSide: BROWSER_SHOT_MAX_SIDE, quality: 70 });
  });

  it("shoots one element by ref, and refuses a stale ref without capturing", async () => {
    const backend = new GateBackend();
    const { deps } = memoryDisk();
    const tool = buildBrowserScreenshotTool(backend, undefined, deps);
    const ok = await tool.run({ ref: "e3" }, GATE_CTX);
    expect(ok.status).toBe("ok");
    expect(backend.shots[0]?.ref).toBe("e3");
    backend.hasRef = async () => false;
    const stale = await tool.run({ ref: "e9" }, GATE_CTX);
    expect(stale.details).toMatchObject({ reason: "stale_ref" });
    expect(backend.shots).toHaveLength(1);
  });

  it("rejects a bad ref and ref + fullPage together", async () => {
    const tool = buildBrowserScreenshotTool(new GateBackend(), undefined, memoryDisk().deps);
    await expect(tool.run({ ref: "e1;alert(1)" }, GATE_CTX)).rejects.toThrow(/alphanumeric/);
    await expect(tool.run({ ref: "e1", fullPage: true }, GATE_CTX)).rejects.toThrow(/not both/);
  });

  it("never captures a page on a blocked host", async () => {
    const backend = new GateBackend();
    backend.url = "https://login.bank.example/";
    const { files, deps } = memoryDisk();
    const result = await buildBrowserScreenshotTool(backend, BLOCK_BANK, deps).run({}, GATE_CTX);
    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ reason: "blocked_domain", host: "login.bank.example" });
    expect(backend.shots).toHaveLength(0);
    expect(files.size).toBe(0);
  });

  it("discards a capture that shows a blocked site in a frame", async () => {
    const backend = new GateBackend();
    backend.shotFrames = ["https://bank.example/widget"];
    const { files, deps } = memoryDisk();
    const result = await buildBrowserScreenshotTool(backend, BLOCK_BANK, deps).run({}, GATE_CTX);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("discarded");
    expect(files.size).toBe(0);
  });

  it("discards a capture when a redirect landed on a blocked host meanwhile", async () => {
    const backend = new GateBackend();
    backend.landDuringShot = "https://bank.example/home";
    const { files, deps } = memoryDisk();
    const result = await buildBrowserScreenshotTool(backend, BLOCK_BANK, deps).run({}, GATE_CTX);
    expect(result.status).toBe("error");
    expect(files.size).toBe(0);
  });

  it("in the user's own Chrome asks before shooting a site not cleared; without a gate refuses", async () => {
    const policy: BrowserDomainPolicy = {
      blockedDomains: [],
      allowedDomains: [],
      userProfile: true,
      userSites: new UserSiteApprovals(),
    };
    const backend = new GateBackend();
    backend.url = "https://mail.example/inbox";
    const { files, deps } = memoryDisk();
    const refused = await buildBrowserScreenshotTool(backend, policy, deps).run({}, GATE_CTX);
    expect(refused.details).toMatchObject({ reason: "user_site_not_cleared", host: "mail.example" });
    const denied = recordingGate(false);
    await expect(buildBrowserScreenshotTool(backend, policy, deps, denied.options).run({}, GATE_CTX))
      .rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(denied.prompts[0]).toMatchObject({ category: "browser_secret", affectedResources: ["mail.example"] });
    expect(backend.shots).toHaveLength(0);
    expect(files.size).toBe(0);

    const allowed = recordingGate(true);
    const ok = await buildBrowserScreenshotTool(backend, policy, deps, allowed.options).run({}, GATE_CTX);
    expect(ok.status).toBe("ok");
    backend.landDuringShot = "https://console.example/keys";
    const moved = await buildBrowserScreenshotTool(backend, policy, deps, allowed.options).run({}, GATE_CTX);
    expect(moved.details).toMatchObject({ reason: "user_site_not_cleared", host: "console.example" });
    expect(files.size).toBe(1);
  });

  it("retakes an oversized picture smaller, then refuses it", async () => {
    const backend = new GateBackend();
    backend.shotBytes = [BROWSER_SHOT_MAX_BYTES + 1, 500_000];
    const { deps } = memoryDisk();
    const tool = buildBrowserScreenshotTool(backend, undefined, deps);
    const smaller = await tool.run({ fullPage: true }, GATE_CTX);
    expect(smaller.status).toBe("ok");
    expect(backend.shots.map((s) => s.quality)).toEqual([70, 50]);
    expect(backend.shots[1]).toMatchObject({ fullPage: true, maxSide: 960 });

    const huge = new GateBackend();
    huge.shotBytes = [BROWSER_SHOT_MAX_BYTES + 1];
    const { files, deps: d2 } = memoryDisk();
    const refused = await buildBrowserScreenshotTool(huge, undefined, d2).run({}, GATE_CTX);
    expect(refused.details).toMatchObject({ reason: "too_large" });
    expect(files.size).toBe(0);
  });
});

describe("planShot", () => {
  it("never upscales and keeps the long side at the cap in device pixels", () => {
    expect(planShot({ x: 0, y: 0, width: 400, height: 300 }, 1, 1280)).toMatchObject({ scale: 1, width: 400, height: 300 });
    const retina = planShot({ x: 0, y: 100, width: 1440, height: 900 }, 2, 1280)!;
    expect(retina.width).toBe(1280);
    expect(retina.height).toBe(800);
    expect(retina.clip).toEqual({ x: 0, y: 100, width: 1440, height: 900 });
  });

  it("cuts a full page at the height cap", () => {
    const plan = planShot({ x: 0, y: 0, width: 1200, height: 30_000 }, 1, 1280, true)!;
    expect(plan.clipped).toBe(true);
    expect(plan.clip.height).toBe(FULL_PAGE_MAX_CSS_HEIGHT);
    expect(Math.max(plan.width, plan.height)).toBeLessThanOrEqual(1280);
  });

  it("is null for an element with no area", () => {
    expect(planShot({ x: 10, y: 10, width: 0, height: 20 }, 1, 1280)).toBeNull();
  });
});
