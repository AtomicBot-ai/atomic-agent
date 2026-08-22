import { describe, expect, it, vi } from "vitest";

import { parsePsRssKb, sampleDaemonRss, type DaemonRssDeps } from "./daemon-rss.js";

function deps(overrides: Partial<DaemonRssDeps> = {}): DaemonRssDeps {
  return {
    mode: () => "managed",
    pid: () => 4242,
    psRss: vi.fn(async () => " 4296875\n"),
    ...overrides,
  };
}

// The suite runs on macOS/Linux; the win32 early-out is a plain branch
// on `process.platform` and is not simulated here.
describe("sampling the managed daemon's RSS", () => {
  it("converts the ps KiB figure to bytes", async () => {
    await expect(sampleDaemonRss(deps())).resolves.toBe(4296875 * 1024);
  });

  it("declines to measure an external llama-server", async () => {
    const pid = vi.fn(() => 4242);
    const d = deps({ mode: () => "external", pid });
    await expect(sampleDaemonRss(d)).resolves.toBe(null);
    // No pid-file read either: external mode is fully out of scope.
    expect(pid).not.toHaveBeenCalled();
  });

  it("reports null when the daemon is down (no pid on record)", async () => {
    await expect(sampleDaemonRss(deps({ pid: () => null }))).resolves.toBe(null);
  });

  it("reports null when the process died under the ps call", async () => {
    const d = deps({
      psRss: vi.fn(async () => {
        throw new Error("ps: no such process");
      }),
    });
    await expect(sampleDaemonRss(d)).resolves.toBe(null);
  });
});

describe("parsing ps output", () => {
  it("trims and scales a normal figure", () => {
    expect(parsePsRssKb(" 1024\n")).toBe(1024 * 1024);
  });

  it("rejects garbage and non-positive figures", () => {
    expect(parsePsRssKb("")).toBe(null);
    expect(parsePsRssKb("RSS")).toBe(null);
    expect(parsePsRssKb("0")).toBe(null);
    expect(parsePsRssKb("-5")).toBe(null);
  });
});
