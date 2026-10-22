import { describe, expect, it } from "vitest";

import {
  DESKTOP_SHARED_WARNING,
  legacyDesktopDirNotice,
  noDesktopSharing,
  type DesktopSharing,
  type ResolvedUninstallPlan,
} from "../../uninstall/index.js";
import { bodyLines } from "./uninstall-modal.js";
import { toPreview } from "./uninstall-orchestrator.js";
import type {
  UninstallFlowState,
  UninstallPreview,
} from "./uninstall-state.js";

const PREVIEW: UninstallPreview = {
  rows: [
    {
      path: "/Users/op/.atomic-agent",
      label: "state",
      size: "1.7 GB",
      group: "data",
    },
    {
      path: "/Users/op/.local/bin/atomic-agent",
      label: "the binary",
      size: "135 MB",
      group: "program",
    },
  ],
  total: "1.8 GB",
  devCheckout: false,
};

function flow(overrides: Partial<UninstallFlowState> = {}): UninstallFlowState {
  return {
    step: "review",
    preview: PREVIEW,
    typed: "",
    cursor: "cancel",
    errors: [],
    ...overrides,
  };
}

const text = (state: UninstallFlowState): string =>
  bodyLines(state, 62)
    .map((line) => line.text)
    .join("\n");

describe("uninstall modal copy", () => {
  it("names every path with its size before asking anything", () => {
    const rendered = text(flow());
    expect(rendered).toContain("/Users/op/.atomic-agent");
    expect(rendered).toContain("1.7 GB");
    expect(rendered).toContain("total: 1.8 GB");
  });

  it("says the removal is permanent, in the warn tone", () => {
    const warnings = bodyLines(flow(), 62)
      .filter((line) => line.tone === "warn")
      .map((line) => line.text)
      .join(" ");
    expect(warnings).toMatch(/cannot be undone/i);
    expect(warnings).toMatch(/no backup/i);
    expect(warnings).toMatch(/memory|sessions|models/i);
  });

  it("repeats the size on the last screen, so the number is the last thing read", () => {
    expect(text(flow({ step: "confirm" }))).toContain("1.8 GB");
  });

  it("asks for the word on the last screen", () => {
    expect(text(flow({ step: "confirm" }))).toContain("uninstall");
  });

  it("says so plainly when there is nothing to remove", () => {
    const rendered = text(
      flow({ preview: { rows: [], total: "0 B", devCheckout: false } }),
    );
    expect(rendered).toMatch(/nothing to remove/i);
    // …and does not threaten the operator over an empty list.
    expect(rendered).not.toMatch(/cannot be undone/i);
  });

  it("flags a dev checkout rather than implying it removed the binary", () => {
    const rendered = text(flow({ preview: { ...PREVIEW, devCheckout: true } }));
    expect(rendered).toMatch(/no installed binary/i);
  });

  it("explains the wait on the closing step", () => {
    expect(text(flow({ step: "closing" }))).toMatch(/shutting the agent down/i);
  });

  it("shows the reason a plan could not be read", () => {
    expect(text(flow({ step: "failed", errors: ["EACCES"] }))).toContain(
      "EACCES",
    );
  });
});

function plan(
  desktop: DesktopSharing,
  paths: readonly string[] = ["/Users/op/.atomic-agent", "/Users/op/.local/bin/atomic-agent"],
): ResolvedUninstallPlan {
  const targets = paths.map((path) => ({
    path,
    label: path.endsWith(".atomic-agent") ? "state" : "the binary",
    group: path.endsWith(".atomic-agent") ? ("data" as const) : ("program" as const),
  }));
  return {
    targets,
    measured: {
      targets: targets.map((t) => ({ ...t, exists: true, bytes: 1024 })),
      totalBytes: 1024 * targets.length,
    },
    devCheckout: false,
    installDir: "/Users/op/.local/bin",
    desktop,
  };
}

const SHARED: DesktopSharing = {
  stateDir: "/Users/op/.atomic-agent",
  signals: ["state-dirs-record"],
  sharesStateDir: true,
  legacyDir: null,
};

/** The review text with the panel's soft wraps joined back up. */
const joined = (state: UninstallFlowState): string =>
  bodyLines(state, 62)
    .map((line) => line.text.trim())
    .join(" ");

describe("uninstall modal: desktop app", () => {
  it("warns right under the state folder row when the desktop shares it", () => {
    const lines = bodyLines(flow({ preview: toPreview(plan(SHARED)) }), 62);
    const stateRow = lines.findIndex((l) => l.text.includes("/Users/op/.atomic-agent "));
    expect(lines[stateRow + 1]?.tone).toBe("warn");
    expect(joined(flow({ preview: toPreview(plan(SHARED)) }))).toContain(
      DESKTOP_SHARED_WARNING,
    );
    // Wrapped, not clipped: every row fits the panel.
    expect(lines.every((l) => l.text.length <= 62)).toBe(true);
  });

  it("says nothing about the desktop when it is not found", () => {
    const rendered = joined(
      flow({ preview: toPreview(plan(noDesktopSharing("/Users/op/.atomic-agent"))) }),
    );
    expect(rendered).not.toContain("desktop app");
  });

  it("does not warn when the state folder is not in the plan (keep-data)", () => {
    const rendered = joined(
      flow({ preview: toPreview(plan(SHARED, ["/Users/op/.local/bin/atomic-agent"])) }),
    );
    expect(rendered).not.toContain(DESKTOP_SHARED_WARNING);
  });

  it("lists an old desktop folder as left in place", () => {
    const legacy: DesktopSharing = {
      ...noDesktopSharing("/Users/op/.atomic-agent"),
      signals: ["legacy-dir"],
      legacyDir: "/Users/op/.atomic-agent-desktop",
    };
    const rendered = joined(flow({ preview: toPreview(plan(legacy)) }));
    expect(rendered).toContain(legacyDesktopDirNotice("/Users/op/.atomic-agent-desktop"));
    expect(rendered).not.toContain(DESKTOP_SHARED_WARNING);
  });

  it("repeats the warning on the last-chance screen, only when it applies", () => {
    const shared = joined(flow({ step: "confirm", preview: toPreview(plan(SHARED)) }));
    expect(shared).toContain(DESKTOP_SHARED_WARNING);
    const alone = joined(
      flow({
        step: "confirm",
        preview: toPreview(plan(noDesktopSharing("/Users/op/.atomic-agent"))),
      }),
    );
    expect(alone).not.toContain("desktop app");
  });

  it("has no left-in-place line when there is no old desktop folder", () => {
    const rendered = joined(flow({ preview: toPreview(plan(SHARED)) }));
    expect(rendered).not.toContain("Left in place");
  });
});
