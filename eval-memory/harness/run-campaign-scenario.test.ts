import { describe, it, expect, vi } from "vitest";

import { runCampaignScenario } from "./run-campaign-scenario.js";

// We never want to spawn the real CLI in a unit test — it would require
// a live llama-server. The driver module is mocked so the helper's
// orchestration (profile seeding + temp dir lifecycle + result
// forwarding) is what's actually under test.
vi.mock("./multi-turn-driver.js", () => ({
  driveMultiTurn: vi.fn(async (opts: { stateDir: string }) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 1,
    sessionId: "test-session",
    turns: [],
    stderrTail: "",
    stderrAll: "",
    // Echo the state dir into the mock result so the test can assert
    // it was threaded through correctly.
    _stateDir: opts.stateDir,
  })),
}));

describe("runCampaignScenario", () => {
  it("creates a fresh stateDir + workingDir per call and removes them by default", async () => {
    const out = await runCampaignScenario({
      profile: "hybrid",
      configOptions: { llamaUrl: "http://127.0.0.1:18991" },
      driver: { prompts: ["hi"], maxSteps: 4, timeoutMs: 1000 },
    });
    expect(out.stateDir).toMatch(/atomic-eval-hybrid-state-/);
    expect(out.workingDir).toMatch(/atomic-eval-hybrid-work-/);
    expect(out.result.exitCode).toBe(0);

    const { existsSync } = await import("node:fs");
    expect(existsSync(out.stateDir)).toBe(false);
    expect(existsSync(out.workingDir)).toBe(false);
  });

  it("retains directories when cleanup is false", async () => {
    const { existsSync, readFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");

    const out = await runCampaignScenario({
      profile: "fts5_only",
      configOptions: { llamaUrl: "http://127.0.0.1:18991" },
      driver: { prompts: ["hi"], maxSteps: 4, timeoutMs: 1000 },
      cleanup: false,
    });
    try {
      expect(existsSync(out.stateDir)).toBe(true);
      // config.json was materialised under the temp stateDir.
      const cfg = JSON.parse(
        readFileSync(join(out.stateDir, "config.json"), "utf8"),
      ) as { memory: { embeddings: { enabled: boolean } } };
      expect(cfg.memory.embeddings.enabled).toBe(false);
    } finally {
      rmSync(out.stateDir, { recursive: true, force: true });
      rmSync(out.workingDir, { recursive: true, force: true });
    }
  });

  it("cleans up even when the driver throws", async () => {
    const driverModule = await import("./multi-turn-driver.js");
    const original = driverModule.driveMultiTurn;
    let capturedStateDir = "";
    vi.mocked(driverModule.driveMultiTurn).mockImplementationOnce(
      async (opts) => {
        capturedStateDir = opts.stateDir;
        throw new Error("driver exploded");
      },
    );

    await expect(
      runCampaignScenario({
        profile: "none",
        configOptions: { llamaUrl: "http://127.0.0.1:18991" },
        driver: { prompts: ["hi"], maxSteps: 4, timeoutMs: 1000 },
      }),
    ).rejects.toThrow("driver exploded");

    const { existsSync } = await import("node:fs");
    expect(capturedStateDir).not.toBe("");
    expect(existsSync(capturedStateDir)).toBe(false);

    // Restore the default mock for any subsequent tests in the suite.
    vi.mocked(driverModule.driveMultiTurn).mockImplementation(original);
  });
});
