import { describe, expect, it, vi } from "vitest";
import { STARTER_LOCAL_MODEL_ID, getLocalModelDef } from "../../local-llm/index.js";
import type { StartedUpgrade } from "../../local-llm/model-upgrade-runner.js";
import { upgradeAfterStarter } from "./starter-upgrade.js";

const runner = vi.hoisted(() => ({ startModelUpgrade: vi.fn() }));
vi.mock("../../local-llm/model-upgrade-runner.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startModelUpgrade: runner.startModelUpgrade,
}));

const machine = { ramGb: 32, gpuBudgetGb: 24, freeDiskGb: 200, cpuOnly: false };
const tiers = { fast: null, balanced: null, quality: null };
const big = getLocalModelDef("gemma-4-26b-a4b");
const starter = { id: STARTER_LOCAL_MODEL_ID, name: "Qwen 3.5 2B GGUF" } as const;

function started(decision: StartedUpgrade["snapshot"]["decision"], job: StartedUpgrade["job"]): () => Promise<StartedUpgrade> {
  return async () => ({ snapshot: { machine, tiers, decision, activeModelId: STARTER_LOCAL_MODEL_ID }, job });
}

/** ATO-1045 / ATO-1475: the starter lands, the best model is suggested, never pulled unasked. */
describe("upgradeAfterStarter", () => {
  it("names the model, its size and the command, without starting a download", async () => {
    const line = await upgradeAfterStarter(starter, {
      start: started({ action: "download", model: big }, null),
    });
    expect(line).toContain(big.name);
    expect(line).toContain(big.sizeLabel);
    expect(line).toContain(`/models pull ${big.id}`);
    expect(line).not.toContain("in the background");
  });

  it("points at /models when the best model is already on disk", async () => {
    const line = await upgradeAfterStarter(starter, { start: started({ action: "switch", model: big }, null) });
    expect(line).toContain("/models");
  });

  it("says nothing when there is nothing better, or the probe failed", async () => {
    expect(await upgradeAfterStarter(starter, { start: started({ action: "none", why: "nothing_fits" }, null) })).toBeNull();
    expect(
      await upgradeAfterStarter(starter, {
        start: async () => {
          throw new Error("probe failed");
        },
      }),
    ).toBeNull();
  });

  it("does nothing for any other model", async () => {
    let asked = false;
    const line = await upgradeAfterStarter(
      { id: "qwen-3.5-4b", name: "Qwen 3.5 4B GGUF" },
      {
        start: async () => {
          asked = true;
          throw new Error("not reached");
        },
      },
    );
    expect(line).toBeNull();
    expect(asked).toBe(false);
  });

  it("by default only decides: the runner is asked for a dry run (ATO-1475)", async () => {
    runner.startModelUpgrade.mockResolvedValueOnce({
      snapshot: { machine, tiers, decision: { action: "download", model: big }, activeModelId: STARTER_LOCAL_MODEL_ID },
      job: null,
    });
    const line = await upgradeAfterStarter(starter);
    expect(runner.startModelUpgrade).toHaveBeenCalledWith({ dryRun: true });
    expect(line).toContain(`/models pull ${big.id}`);
  });
});
