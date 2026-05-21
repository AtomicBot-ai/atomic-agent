import { describe, it, expect } from "vitest";
import {
  cycleMemoryChannel,
  cycleNotesArchiveFilter,
  selectVisibleMemoryRows,
} from "./memory-filter.js";
import { createInitialMemoryPanelState } from "./memory-panel-state.js";

describe("memory-filter", () => {
  it("filters rows by search substring", () => {
    const panel = {
      ...createInitialMemoryPanelState(),
      rows: [
        {
          rowKey: "a",
          channel: "profile" as const,
          primary: "email",
          secondary: "user@x.com",
          meta: "",
        },
        {
          rowKey: "b",
          channel: "profile" as const,
          primary: "name",
          secondary: "Alex",
          meta: "",
        },
      ],
      searchQuery: "email",
    };
    expect(selectVisibleMemoryRows(panel)).toHaveLength(1);
    expect(selectVisibleMemoryRows(panel)[0]!.primary).toBe("email");
  });

  it("cycles notes archive filter", () => {
    expect(cycleNotesArchiveFilter("active", 1)).toBe("archived");
    expect(cycleNotesArchiveFilter("archived", 1)).toBe("all");
  });

  it("cycles channels within available set", () => {
    const next = cycleMemoryChannel("profile", ["profile", "notes"], 1);
    expect(next).toBe("notes");
  });
});
