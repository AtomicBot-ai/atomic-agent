import { describe, expect, it } from "vitest";

import { bodyLines } from "./uninstall-modal.js";
import type {
  UninstallFlowState,
  UninstallPreview,
} from "../uninstall/uninstall-state.js";

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
