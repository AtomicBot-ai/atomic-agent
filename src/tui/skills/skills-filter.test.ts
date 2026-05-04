import { describe, expect, it } from "vitest";
import {
  cycleSkillsFilter,
  filterAndSortSkillRows,
  selectVisibleSkillRows,
} from "./skills-filter.js";
import type { SkillSummaryRow } from "./skills-panel-state.js";

const ROWS: readonly SkillSummaryRow[] = [
  {
    name: "zeta",
    description: "z",
    version: "0",
    source: "global",
    disabled: false,
  },
  {
    name: "alpha",
    description: "a",
    version: "0",
    source: "global",
    disabled: true,
  },
  {
    name: "beta",
    description: "b",
    version: "0",
    source: "global",
    disabled: false,
  },
  {
    name: "gamma",
    description: "g",
    version: "0",
    source: "global",
    disabled: true,
  },
];

describe("filterAndSortSkillRows", () => {
  it("sorts enabled first then disabled, alphabetically within each bucket", () => {
    const out = filterAndSortSkillRows(ROWS, { status: "all" });
    expect(out.map((r) => r.name)).toEqual(["beta", "zeta", "alpha", "gamma"]);
  });

  it("filters to enabled-only", () => {
    const out = filterAndSortSkillRows(ROWS, { status: "enabled" });
    expect(out.map((r) => r.name)).toEqual(["beta", "zeta"]);
  });

  it("filters to disabled-only", () => {
    const out = filterAndSortSkillRows(ROWS, { status: "disabled" });
    expect(out.map((r) => r.name)).toEqual(["alpha", "gamma"]);
  });
});

describe("cycleSkillsFilter", () => {
  it("cycles all → enabled → disabled → all", () => {
    expect(cycleSkillsFilter("all", 1)).toBe("enabled");
    expect(cycleSkillsFilter("enabled", 1)).toBe("disabled");
    expect(cycleSkillsFilter("disabled", 1)).toBe("all");
  });

  it("cycles backwards", () => {
    expect(cycleSkillsFilter("all", -1)).toBe("disabled");
  });
});

describe("selectVisibleSkillRows", () => {
  it("returns the filtered+sorted slice", () => {
    expect(
      selectVisibleSkillRows({ rows: ROWS, filterStatus: "enabled" }).map(
        (r) => r.name,
      ),
    ).toEqual(["beta", "zeta"]);
  });
});
