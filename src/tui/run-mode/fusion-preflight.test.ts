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

  it("names the missing cloud key first", () => {
    expect(describeFusionBlocker(localState())).toMatch(/needs a cloud provider with a key/);
    const keyless = fusionState();
    const state = {
      ...keyless,
      providersPanel: {
        ...keyless.providersPanel,
        rows: keyless.providersPanel.rows.map((row) => ({ ...row, hasApiKey: false })),
      },
    };
    expect(describeFusionBlocker(state)).toMatch(/Manage › LLM › Cloud/);
  });

  it("names the missing local model once the snapshot has landed", () => {
    const base = cloudState();
    const state = {
      ...base,
      localModelsPanel: { ...base.localModelsPanel, rows: [], lastRefreshedAt: 1 },
    };
    expect(describeFusionBlocker(state)).toMatch(/needs a downloaded local model/);
  });

  it("abstains on the model check before the first snapshot", () => {
    const base = cloudState();
    const state = {
      ...base,
      localModelsPanel: { ...base.localModelsPanel, rows: [], lastRefreshedAt: null },
    };
    expect(describeFusionBlocker(state)).toBeNull();
  });
});
