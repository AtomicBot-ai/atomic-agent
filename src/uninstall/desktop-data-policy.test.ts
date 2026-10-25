import { describe, expect, it } from "vitest";

import { keepDesktopData, plansToDeleteDesktopData } from "./desktop-data-policy.js";
import { noDesktopSharing, type DesktopSharing } from "./detect-desktop-sharing.js";
import type { ResolvedUninstallPlan } from "./resolve-uninstall-plan.js";

const STATE_DIR = "/Users/op/.atomic-agent";
const DEBUG_DIR = "/Users/op/Documents/atomic-agent-debug";
const BINARY = "/Users/op/.local/bin/atomic-agent";

const SHARED: DesktopSharing = {
  stateDir: STATE_DIR,
  signals: ["state-dirs-record"],
  sharesStateDir: true,
  legacyDir: null,
};

function makePlan(
  desktop: DesktopSharing,
  paths: readonly string[] = [STATE_DIR, DEBUG_DIR, BINARY],
): ResolvedUninstallPlan {
  const targets = paths.map((path) => ({
    path,
    label: path,
    group: path === BINARY ? ("program" as const) : ("data" as const),
  }));
  return {
    targets,
    measured: {
      targets: targets.map((t, i) => ({ ...t, exists: true, bytes: 10 ** (i + 1) })),
      totalBytes: targets.reduce((sum, _t, i) => sum + 10 ** (i + 1), 0),
    },
    devCheckout: false,
    installDir: "/Users/op/.local/bin",
    desktop,
  };
}

describe("plansToDeleteDesktopData", () => {
  it("is true when the desktop shares the state folder and the plan removes it", () => {
    expect(plansToDeleteDesktopData(makePlan(SHARED))).toBe(true);
  });

  it("is false when the desktop app is not found", () => {
    expect(plansToDeleteDesktopData(makePlan(noDesktopSharing(STATE_DIR)))).toBe(false);
  });

  it("is false when the state folder is not in the plan (--keep-data)", () => {
    expect(plansToDeleteDesktopData(makePlan(SHARED, [BINARY]))).toBe(false);
  });
});

describe("keepDesktopData", () => {
  it("drops every data target, like --keep-data, and re-totals the sizes", () => {
    const kept = keepDesktopData(makePlan(SHARED));
    expect(kept.targets.map((t) => t.path)).toEqual([BINARY]);
    expect(kept.measured.targets.map((t) => t.path)).toEqual([BINARY]);
    expect(kept.measured.totalBytes).toBe(1000);
    expect(plansToDeleteDesktopData(kept)).toBe(false);
  });

  it("keeps the desktop findings so the caller can still explain itself", () => {
    const kept = keepDesktopData(makePlan(SHARED));
    expect(kept.desktop).toEqual(SHARED);
    expect(kept.installDir).toBe("/Users/op/.local/bin");
  });
});
