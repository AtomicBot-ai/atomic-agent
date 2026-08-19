import { describe, expect, it } from "vitest";

import { handleMenuKey, resolveLeaderChord } from "./menu-keys.js";
import type { MenuNode } from "./menu-registry.js";
import {
  selectMenuItems,
  selectMenuRows,
  selectMenuTitle,
} from "./menu-selectors.js";
import type { TuiAction } from "../tui-action.js";
import { createInitialTuiState } from "../tui-state.js";
import type { TuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";

const KEY = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  pageDown: false, pageUp: false, return: false, escape: false, ctrl: false,
  shift: false, tab: false, backspace: false, delete: false, meta: false,
} as const;

function open(patch: Partial<TuiState> = {}): TuiState {
  return { ...createInitialTuiState(fakeSession()), menuOpen: true, ...patch };
}

function drive(state: TuiState, input: string, key: Partial<typeof KEY>) {
  const actions: TuiAction[] = [];
  const activated: MenuNode[] = [];
  const handled = handleMenuKey(input, { ...KEY, ...key } as never, {
    state,
    dispatch: (a) => actions.push(a),
    activate: (n) => activated.push(n),
  });
  return { handled, actions, activated };
}

describe("menu rows", () => {
  it("shows group headings and the two submenus at the root", () => {
    const rows = selectMenuRows(open());
    const headers = rows.flatMap((r) => (r.kind === "header" ? [r.label] : []));
    expect(headers).toEqual(["Go", "Session", "Model", "Run", "Setup", "Help"]);
    const go = rows.filter((r) => r.kind === "item" && r.node.group === "go");
    expect(go.map((r) => (r.kind === "item" ? r.node.label : ""))).toEqual([
      "Run",
      "Toggle debug pane",
      "Observe",
      "Manage",
    ]);
  });

  it("lists a submenu's children and titles the popup with a breadcrumb", () => {
    const state = open({ menuPath: "go.manage" });
    expect(selectMenuTitle(state)).toContain("Manage");
    const labels = selectMenuItems(state).map((r) => r.node.label);
    expect(labels).toEqual([
      "Tasks", "Skills", "Memory", "MCP", "LLM", "Telegram", "Import", "Privacy",
    ]);
  });

  it("flattens the tree when searching and keeps a breadcrumb on each hit", () => {
    const state = open({ menuQuery: "privacy" });
    const items = selectMenuItems(state);
    const privacy = items.find((r) => r.node.id === "go.manage.privacy");
    expect(privacy).toBeDefined();
    expect(privacy?.crumb).toBe("Manage");
    expect(items.some((r) => r.node.kind === "submenu")).toBe(false);
  });

  it("searching from inside a submenu still reaches the whole registry", () => {
    const state = open({ menuPath: "go.manage", menuQuery: "feed" });
    const ids = selectMenuItems(state).map((r) => r.node.id);
    expect(ids).toContain("go.observe.feed");
  });

  it("carries live counts onto destinations", () => {
    const base = createInitialTuiState(fakeSession());
    const state = open({
      tasksPanel: { ...base.tasksPanel, rows: [{}, {}] as never },
      menuPath: "go.manage",
    });
    const tasks = selectMenuItems(state).find((r) => r.node.id === "go.manage.tasks");
    expect(tasks?.status).toBe("2 tasks");
  });
});

describe("menu keys", () => {
  it("moves the cursor with the arrows only, so letters stay available for search", () => {
    expect(drive(open(), "", { downArrow: true }).actions).toEqual([
      { type: "menu_cursor_moved", delta: 1 },
    ]);
    expect(drive(open(), "j", {}).actions).toEqual([
      { type: "menu_query_changed", query: "j" },
      { type: "menu_cursor_set", cursor: 0 },
    ]);
  });

  it("opens a submenu with the right arrow and leaves it with the left", () => {
    const atManage = open({ menuCursor: 2 });
    expect(drive(atManage, "", { rightArrow: true }).actions).toEqual([
      { type: "menu_path_set", path: "go.observe" },
      { type: "menu_cursor_set", cursor: 0 },
    ]);
    const inside = open({ menuPath: "go.manage" });
    expect(drive(inside, "", { leftArrow: true }).actions).toEqual([
      { type: "menu_path_set", path: null },
      { type: "menu_cursor_set", cursor: 0 },
    ]);
  });

  it("closes before activating, so the menu is never left over a new screen", () => {
    const state = open({ menuPath: "go.manage" });
    const { actions, activated } = drive(state, "", { return: true });
    expect(actions).toEqual([{ type: "menu_closed" }]);
    expect(activated.map((n) => n.id)).toEqual(["go.manage.tasks"]);
  });

  it("takes a whole burst into the search box, so a paste is not swallowed", () => {
    expect(drive(open(), "privacy", {}).actions).toEqual([
      { type: "menu_query_changed", query: "privacy" },
      { type: "menu_cursor_set", cursor: 0 },
    ]);
  });

  it("keeps escape-sequence fragments out of the query", () => {
    const arrow = String.fromCharCode(27) + "[A";
    expect(drive(open(), arrow, {}).actions).toEqual([]);
  });

  it("swallows every key while open so no panel below can act on it", () => {
    for (const [input, key] of [["x", {}], ["", { tab: true }], ["", { pageUp: true }]] as const) {
      expect(drive(open(), input, key).handled).toBe(true);
    }
  });

  it("declines every key when closed", () => {
    const closed = { ...createInitialTuiState(fakeSession()), menuOpen: false };
    expect(drive(closed, "x", {}).handled).toBe(false);
  });
});

describe("leader chords", () => {
  it("resolves a place from the key pressed after ctrl+g", () => {
    expect(resolveLeaderChord("t", KEY as never)?.id).toBe("go.manage.tasks");
    expect(resolveLeaderChord("f", KEY as never)?.id).toBe("go.observe.feed");
  });

  it("resolves nothing for an unclaimed key or an escape", () => {
    expect(resolveLeaderChord("z", KEY as never)).toBeNull();
    expect(resolveLeaderChord("", { ...KEY, escape: true } as never)).toBeNull();
  });
});
