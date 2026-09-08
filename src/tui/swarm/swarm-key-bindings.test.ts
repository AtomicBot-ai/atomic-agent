import { describe, expect, it, vi } from "vitest";
import type { Key } from "ink";

import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { handleSwarmTabKey } from "./swarm-key-bindings.js";
import { createInitialSwarmPanelState, type SwarmPanelState, type SwarmRow } from "./swarm-panel-state.js";

const KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
} as Key;

function row(over: Partial<SwarmRow> = {}): SwarmRow {
  return {
    id: "ops",
    kind: "telegram",
    primary: false,
    label: "Ops",
    role: "",
    enabled: true,
    hasToken: true,
    ownerUserId: null,
    state: "up",
    lastError: null,
    botUsername: null,
    pairing: null,
    ...over,
  };
}

function ctxOf(panel: Partial<SwarmPanelState>, callbacks: Partial<TuiAppCallbacks> = {}) {
  const dispatch = vi.fn();
  const state = {
    uiMode: "debug",
    activeTab: "swarm",
    swarmPanel: { ...createInitialSwarmPanelState(), ...panel },
  } as unknown as TuiState;
  return { ctx: { state, dispatch, callbacks: callbacks as TuiAppCallbacks }, dispatch };
}

describe("handleSwarmTabKey", () => {
  it("declines keys when the tab is not active", () => {
    const { ctx } = ctxOf({});
    ctx.state = { ...ctx.state, activeTab: "tasks" } as TuiState;
    expect(handleSwarmTabKey("a", KEY, ctx)).toBe(false);
  });

  it("list: a opens the wizard, enter toggles, d asks to remove a unit", () => {
    const rows = [row({ id: "primary:telegram", primary: true }), row()];
    const onSwarmToggleRequested = vi.fn();
    const { ctx, dispatch } = ctxOf({ rows, selected: 1 }, { onSwarmToggleRequested });
    expect(handleSwarmTabKey("a", KEY, ctx)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "swarm_add_started" });
    expect(handleSwarmTabKey("", { ...KEY, return: true }, ctx)).toBe(true);
    expect(onSwarmToggleRequested).toHaveBeenCalledWith("ops");
    expect(handleSwarmTabKey("d", KEY, ctx)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "swarm_remove_started" });
  });

  it("wizard: token step swallows every printable key and enter on the owner step submits", () => {
    const onSwarmAddRequested = vi.fn();
    const form = { step: "token" as const, kind: "discord" as const, label: "Ops", role: "r", token: "ab", owner: "" };
    const { ctx, dispatch } = ctxOf({ mode: "add", form }, { onSwarmAddRequested });
    // `d` would be "remove" in the list; here it is token material.
    expect(handleSwarmTabKey("d", KEY, ctx)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "swarm_form_changed", value: "abd" });
    expect(handleSwarmTabKey("", { ...KEY, backspace: true }, ctx)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "swarm_form_changed", value: "a" });
    const owner = ctxOf({ mode: "add", form: { ...form, step: "owner", owner: "42" } }, { onSwarmAddRequested });
    expect(handleSwarmTabKey("", { ...KEY, return: true }, owner.ctx)).toBe(true);
    expect(onSwarmAddRequested).toHaveBeenCalledWith({
      kind: "discord",
      label: "Ops",
      role: "r",
      token: "ab",
      ownerUserId: "42",
    });
  });

  it("wizard: the kind step picks with arrows or t/d and esc walks back", () => {
    const { ctx, dispatch } = ctxOf({ mode: "add" });
    expect(handleSwarmTabKey("", { ...KEY, rightArrow: true }, ctx)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "swarm_form_kind_set", kind: "discord" });
    expect(handleSwarmTabKey("t", KEY, ctx)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "swarm_form_kind_set", kind: "telegram" });
    expect(handleSwarmTabKey("", { ...KEY, escape: true }, ctx)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "swarm_form_back" });
  });

  it("edit: enter starts typing, enter again saves the field", () => {
    const onSwarmFieldSaveRequested = vi.fn();
    const browsing = ctxOf({ mode: "edit", rows: [row()], editField: "role" }, { onSwarmFieldSaveRequested });
    expect(handleSwarmTabKey("", { ...KEY, return: true }, browsing.ctx)).toBe(true);
    expect(browsing.dispatch).toHaveBeenCalledWith({ type: "swarm_edit_typing_started" });
    const typing = ctxOf(
      { mode: "edit", rows: [row()], editField: "role", editBuffer: "deploys" },
      { onSwarmFieldSaveRequested },
    );
    expect(handleSwarmTabKey("", { ...KEY, return: true }, typing.ctx)).toBe(true);
    expect(onSwarmFieldSaveRequested).toHaveBeenCalledWith("ops", "role", "deploys");
  });

  it("remove: y confirms, anything else keeps the bot", () => {
    const onSwarmRemoveRequested = vi.fn();
    const { ctx, dispatch } = ctxOf({ mode: "remove", rows: [row()] }, { onSwarmRemoveRequested });
    expect(handleSwarmTabKey("n", KEY, ctx)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "swarm_cancelled" });
    expect(onSwarmRemoveRequested).not.toHaveBeenCalled();
    expect(handleSwarmTabKey("y", KEY, ctx)).toBe(true);
    expect(onSwarmRemoveRequested).toHaveBeenCalledWith("ops");
  });

  it("swallows everything while busy", () => {
    const { ctx, dispatch } = ctxOf({ busy: true, rows: [row()] });
    expect(handleSwarmTabKey("a", KEY, ctx)).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
