import { describe, expect, it, vi } from "vitest";

import {
  openRunModeSetup,
  runModeSetupOffer,
  runModeSetupTarget,
  type RunModeLegAvailability,
} from "./run-mode-setup.js";

const BOTH: RunModeLegAvailability = {
  cloudProviderMissing: false,
  localProviderMissing: false,
};
const NO_CLOUD: RunModeLegAvailability = {
  cloudProviderMissing: true,
  localProviderMissing: false,
};
const NO_LOCAL: RunModeLegAvailability = {
  cloudProviderMissing: false,
  localProviderMissing: true,
};
const NEITHER: RunModeLegAvailability = {
  cloudProviderMissing: true,
  localProviderMissing: true,
};

describe("runModeSetupTarget", () => {
  it("clears every mode when both legs are configured", () => {
    for (const mode of ["local", "cloud", "fusion"] as const) {
      expect(runModeSetupTarget(mode, BOTH)).toBeNull();
    }
  });

  it("does not send Local to the cloud wizard", () => {
    // The whole point of routing per mode: a missing cloud key has
    // nothing to do with whether Local can run.
    expect(runModeSetupTarget("local", NO_CLOUD)).toBeNull();
    expect(runModeSetupTarget("local", NO_LOCAL)).toBe("local-runtime");
  });

  it("sends Cloud to the cloud wizard and nowhere else", () => {
    expect(runModeSetupTarget("cloud", NO_CLOUD)).toBe("cloud-provider");
    expect(runModeSetupTarget("cloud", NO_LOCAL)).toBeNull();
  });

  it("fixes fusion's cloud leg first, because without it fusion cannot run at all", () => {
    expect(runModeSetupTarget("fusion", NEITHER)).toBe("cloud-provider");
    expect(runModeSetupTarget("fusion", NO_LOCAL)).toBe("local-runtime");
  });
});

describe("runModeSetupOffer", () => {
  it("keeps a fresh install's way out visible from the Local row", () => {
    // The overlay opens with the cursor on the mode in force, which on a
    // fresh install is Local — the one mode that works. A strict answer
    // would hide the offer exactly where the dead end used to be.
    expect(runModeSetupTarget("local", NO_CLOUD)).toBeNull();
    expect(runModeSetupOffer("local", NO_CLOUD)).toBe("cloud-provider");
  });

  it("still prefers the highlighted mode's own missing leg", () => {
    expect(runModeSetupOffer("local", NEITHER)).toBe("local-runtime");
  });

  it("offers nothing when there is nothing to fix", () => {
    expect(runModeSetupOffer("fusion", BOTH)).toBeNull();
  });
});

describe("openRunModeSetup", () => {
  const dispatched = (target: "cloud-provider" | "local-runtime") => {
    const dispatch = vi.fn();
    openRunModeSetup(dispatch, target);
    return dispatch.mock.calls.map(([action]) => action);
  };

  it("closes the overlay and lands on the LLM tab for either leg", () => {
    for (const target of ["cloud-provider", "local-runtime"] as const) {
      expect(dispatched(target).slice(0, 3)).toEqual([
        { type: "run_mode_picker_closed" },
        { type: "ui_mode_set", mode: "debug" },
        { type: "tab_changed", tab: "llm" },
      ]);
    }
  });

  it("opens the add-provider wizard only for the cloud leg", () => {
    expect(dispatched("cloud-provider")).toContainEqual(
      expect.objectContaining({ type: "providers_wizard_opened" }),
    );
    // The Local pane IS the checklist; a wizard on top of it would hide
    // the backend/model/daemon rows the operator came for.
    expect(dispatched("local-runtime")).not.toContainEqual(
      expect.objectContaining({ type: "providers_wizard_opened" }),
    );
    expect(dispatched("local-runtime")).toContainEqual({
      type: "llm_mode_set",
      mode: "local",
    });
  });
});
