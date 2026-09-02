import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { planUpdateBanner, UpdateBanner } from "./update-banner.js";

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

describe("UpdateBanner", () => {
  it("says the whole sentence when the row has room", () => {
    const view = render(<UpdateBanner latest="9.9.9" budget={60} />);
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("new version v9.9.9 available");
    expect(frame).toContain("Update");
  });

  it("sheds the sentence, then the version, as the row fills up", () => {
    const medium = strip(
      render(<UpdateBanner latest="9.9.9" budget={20} />).lastFrame() ?? "",
    );
    expect(medium).toContain("v9.9.9");
    expect(medium).not.toContain("new version");
    expect(medium).toContain("Update");

    const tight = strip(
      render(<UpdateBanner latest="9.9.9" budget={9} />).lastFrame() ?? "",
    );
    expect(tight).toContain("Update");
    expect(tight).not.toContain("9.9.9");
  });

  it("disappears rather than wrapping the one-row bar", () => {
    const view = render(<UpdateBanner latest="9.9.9" budget={5} />);
    expect(strip(view.lastFrame() ?? "").trim()).toBe("");
  });

  it("never plans a form wider than its budget", () => {
    for (const latest of ["1.0.0", "10.20.30", "0.5.5-rc.1"]) {
      for (let budget = 0; budget <= 60; budget += 1) {
        const plan = planUpdateBanner(latest, budget);
        if (plan) expect(plan.width).toBeLessThanOrEqual(budget);
      }
    }
  });
});
