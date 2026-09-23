import { describe, expect, it } from "vitest";

import {
  cloudState,
  fusionState,
  localState,
} from "../composer-switch/composer-switch-fixtures.js";
import { describeFusionBlocker } from "./fusion-preflight.js";

describe("describeFusionBlocker", () => {
  it("passes when a keyed cloud provider and a downloaded model exist", () => {
    expect(describeFusionBlocker(fusionState())).toBeNull();
  });

  it("names the second leg as missing when only the local one can answer", () => {
    // `localState()` has the llama-server row and no keyed cloud one:
    // one usable leg, so fusion is one provider short — and the one it
    // is short of is the orchestrator, because the local leg is there.
    expect(describeFusionBlocker(localState())).toMatch(
      /needs a second provider to orchestrate/,
    );
  });

  it("counts a keyless cloud row as unable to answer", () => {
    const keyless = fusionState();
    const state = {
      ...keyless,
      providersPanel: {
        ...keyless.providersPanel,
        rows: keyless.providersPanel.rows.map((row) => ({
          ...row,
          hasApiKey: false,
        })),
      },
    };
    expect(describeFusionBlocker(state)).toMatch(/Manage › LLM/);
  });

  it("names the missing second leg when nothing is downloaded", () => {
    // A keyed cloud provider and a local row with an empty disk: the
    // cloud leg can answer, the local one cannot, so the pair is short
    // by one — whichever kind the operator fills it with.
    const base = cloudState();
    const state = {
      ...base,
      localModelsPanel: {
        ...base.localModelsPanel,
        rows: [],
        lastRefreshedAt: 1,
      },
    };
    expect(describeFusionBlocker(state)).toMatch(/needs a second provider/);
  });

  it("abstains on the model check before the first snapshot", () => {
    const base = cloudState();
    const state = {
      ...base,
      localModelsPanel: {
        ...base.localModelsPanel,
        rows: [],
        lastRefreshedAt: null,
      },
    };
    expect(describeFusionBlocker(state)).toBeNull();
  });
});
