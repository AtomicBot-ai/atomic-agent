import { describe, expect, it } from "vitest";
import { STARTER_LOCAL_MODEL_ID, getLocalModelDef } from "../../local-llm/index.js";
import type { StartedUpgrade } from "../../local-llm/model-upgrade-runner.js";
import { upgradeAfterStarter } from "./starter-upgrade.js";

const machine = { ramGb: 32, gpuBudgetGb: 24, freeDiskGb: 200, cpuOnly: false };
const tiers = { fast: null, balanced: null, quality: null };
const big = getLocalModelDef("gemma-4-26b-a4b");
const starter = { id: STARTER_LOCAL_MODEL_ID, name: "Qwen 3.5 2B GGUF" } as const;

function started(decision: StartedUpgrade["snapshot"]["decision"], job: StartedUpgrade["job"]): () => Promise<StartedUpgrade> {
  return async () => ({ snapshot: { machine, tiers, decision, activeModelId: STARTER_LOCAL_MODEL_ID }, job });
}

/** ATO-1045: the starter lands, the best model follows in the background. */
describe("upgradeAfterStarter", () => {
  it("starts the download and says what follows", async () => {
    const line = await upgradeAfterStarter(starter, {
      start: started({ action: "download", model: big }, { id: "chat-gemma-4-26b-a4b", pid: 42, started: true }),
    });
    expect(line).toContain(big.name);
    expect(line).toContain("in the background");
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
});
