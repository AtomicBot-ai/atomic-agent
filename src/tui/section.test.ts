import { describe, expect, it } from "vitest";
import {
  cycleNavSlot,
  cycleSubTab,
  getCurrentNavSlot,
  getCurrentSection,
  MANAGE_TABS,
  NAV_SLOT_ORDER,
  OBSERVE_TABS,
} from "./section.js";
import { createInitialTuiState, type TuiSessionInfo } from "./tui-state.js";

const SESSION: TuiSessionInfo = {
  sessionId: null,
  workingDir: "/tmp",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalRequired: false,
  maxSteps: 5,
  skillCount: 0,
};

function chatState() {
  return createInitialTuiState(SESSION, 64);
}

function debugState(tab: import("./tui-state.js").TuiTab) {
  return {
    ...createInitialTuiState(SESSION, 64),
    uiMode: "debug" as const,
    activeTab: tab,
  };
}

describe("section nav model", () => {
  it("derives the section from ui mode and active tab", () => {
    expect(getCurrentSection(chatState())).toBe("run");
    expect(getCurrentSection(debugState("feed"))).toBe("observe");
    expect(getCurrentSection(debugState("logs"))).toBe("observe");
    expect(getCurrentSection(debugState("tasks"))).toBe("manage");
    expect(getCurrentSection(debugState("telegram"))).toBe("manage");
  });

  it("returns null sub-tab cycle from the run section", () => {
    expect(cycleSubTab(chatState(), 1)).toBeNull();
    expect(cycleSubTab(chatState(), -1)).toBeNull();
  });

  it("orders nav slots as run → observe tabs → manage tabs", () => {
    const order = NAV_SLOT_ORDER.map((slot) =>
      slot.kind === "run" ? "run" : slot.tab,
    );
    expect(order).toEqual([
      "run",
      ...OBSERVE_TABS,
      ...MANAGE_TABS,
    ]);
    expect(MANAGE_TABS).toContain("llm");
    expect(MANAGE_TABS).not.toContain("providers");
    expect(MANAGE_TABS).not.toContain("models");
  });

  it("cycles forward across sections starting from chat", () => {
    const next = cycleNavSlot(chatState(), 1);
    expect(next).toEqual({ kind: "debug-tab", tab: "feed" });
  });

  it("wraps from the last manage tab back to chat", () => {
    const lastManage = MANAGE_TABS[MANAGE_TABS.length - 1]!;
    const next = cycleNavSlot(debugState(lastManage), 1);
    expect(next).toEqual({ kind: "run" });
  });

  it("cycles backwards from chat into the last manage tab", () => {
    const next = cycleNavSlot(chatState(), -1);
    const lastManage = MANAGE_TABS[MANAGE_TABS.length - 1]!;
    expect(next).toEqual({ kind: "debug-tab", tab: lastManage });
  });

  it("crosses the observe / manage boundary forward", () => {
    const lastObserve = OBSERVE_TABS[OBSERVE_TABS.length - 1]!;
    const next = cycleNavSlot(debugState(lastObserve), 1);
    expect(next).toEqual({ kind: "debug-tab", tab: MANAGE_TABS[0] });
  });

  it("crosses the manage / observe boundary backwards", () => {
    const next = cycleNavSlot(debugState(MANAGE_TABS[0]!), -1);
    expect(next).toEqual({
      kind: "debug-tab",
      tab: OBSERVE_TABS[OBSERVE_TABS.length - 1],
    });
  });

  it("projects state onto a nav slot", () => {
    expect(getCurrentNavSlot(chatState())).toEqual({ kind: "run" });
    expect(getCurrentNavSlot(debugState("logs"))).toEqual({
      kind: "debug-tab",
      tab: "logs",
    });
  });
});
