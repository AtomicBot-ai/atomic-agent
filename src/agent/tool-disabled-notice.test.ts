import { describe, expect, it } from "vitest";

import { toolDisabledEvents, toolDisabledNotice } from "./tool-disabled-notice.js";

describe("tool_disabled (ATO-1417)", () => {
  it("says which tool the model cannot use and why, in one sentence", () => {
    expect(toolDisabledNotice("notion.search")).toBe(
      "Tool notion.search is disabled for this turn: the model server did not accept its schema.",
    );
  });

  it("one event per tool the turn has not announced yet", () => {
    const announced = new Set<string>();
    const dropped = [
      { name: "notion.search", reason: "schema_rejected" as const },
      { name: "records.lookup", reason: "schema_rejected" as const },
    ];
    expect(toolDisabledEvents(dropped, announced, 1)).toEqual([
      { type: "tool_disabled", stepIndex: 1, tool: "notion.search", reason: "schema_rejected" },
      { type: "tool_disabled", stepIndex: 1, tool: "records.lookup", reason: "schema_rejected" },
    ]);
    // The next step sends the same tools and is refused the same way.
    expect(toolDisabledEvents(dropped, announced, 2)).toEqual([]);
    expect([...announced]).toEqual(["notion.search", "records.lookup"]);
  });

  it("nothing for a completion that dropped nothing", () => {
    const announced = new Set<string>();
    expect(toolDisabledEvents(undefined, announced, 0)).toEqual([]);
    expect(toolDisabledEvents([], announced, 0)).toEqual([]);
    expect(announced.size).toBe(0);
  });
});
