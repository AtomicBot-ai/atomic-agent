import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reportAnalyticsOptOut = vi.fn(async (..._args: unknown[]) => {});

vi.mock("../analytics/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../analytics/index.js")>();
  return {
    ...actual,
    reportAnalyticsOptOut: (...args: unknown[]) =>
      reportAnalyticsOptOut(...args),
  };
});

import { configCommand } from "./config-command.js";
import { resetConfigCache } from "../config/index.js";

describe("config set analytics.enabled false", () => {
  let stateDir: string;
  const prevSurface = process.env.ATOMIC_AGENT_SURFACE;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-cli-optout-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    delete process.env.ATOMIC_AGENT_SURFACE;
    resetConfigCache();
    reportAnalyticsOptOut.mockClear();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    if (prevSurface === undefined) delete process.env.ATOMIC_AGENT_SURFACE;
    else process.env.ATOMIC_AGENT_SURFACE = prevSurface;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  it("sends analytics_disabled via config from the terminal", async () => {
    const code = await configCommand(["set", "analytics.enabled", "false"]);
    expect(code).toBe(0);
    expect(reportAnalyticsOptOut).toHaveBeenCalledTimes(1);
    expect(reportAnalyticsOptOut.mock.calls[0]![0]).toMatchObject({
      via: "config",
    });
  });

  it("skips it when the desktop app runs the command", async () => {
    process.env.ATOMIC_AGENT_SURFACE = "desktop";
    const code = await configCommand(["set", "analytics.enabled", "false"]);
    expect(code).toBe(0);
    expect(reportAnalyticsOptOut).not.toHaveBeenCalled();
  });

  it("skips it for the whole-file form under the desktop app too", async () => {
    process.env.ATOMIC_AGENT_SURFACE = "desktop";
    const code = await configCommand([
      "set",
      JSON.stringify({ analytics: { enabled: false } }),
    ]);
    expect(code).toBe(0);
    expect(reportAnalyticsOptOut).not.toHaveBeenCalled();
  });
});
