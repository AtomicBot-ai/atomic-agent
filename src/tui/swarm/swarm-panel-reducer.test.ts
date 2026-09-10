import { describe, expect, it } from "vitest";

import type { TuiState } from "../tui-state.js";
import { reduceSwarmAction } from "./swarm-panel-reducer.js";
import {
  aliveSwarmCount,
  createInitialSwarmPanelState,
  type SwarmPanelState,
  type SwarmRow,
} from "./swarm-panel-state.js";

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

const PRIMARY = row({
  id: "primary:telegram",
  primary: true,
  label: "Telegram",
});

function stateWith(panel: Partial<SwarmPanelState>): TuiState {
  return {
    swarmPanel: { ...createInitialSwarmPanelState(), ...panel },
  } as unknown as TuiState;
}

function reduce(
  panel: Partial<SwarmPanelState>,
  ...actions: Array<{ type: string } & Record<string, unknown>>
): SwarmPanelState {
  let state = stateWith(panel);
  for (const action of actions)
    state = reduceSwarmAction(state, action) ?? state;
  return state.swarmPanel;
}

describe("reduceSwarmAction", () => {
  it("ignores foreign actions", () => {
    const state = stateWith({});
    expect(reduceSwarmAction(state, { type: "tab_changed" })).toBeNull();
  });

  it("synced replaces rows and clamps the cursor", () => {
    const panel = reduce(
      { selected: 5 },
      { type: "swarm_synced", rows: [PRIMARY, row()] },
    );
    expect(panel.rows).toHaveLength(2);
    expect(panel.selected).toBe(1);
  });

  it("moves within the list only", () => {
    const rows = [PRIMARY, row()];
    expect(reduce({ rows }, { type: "swarm_moved", delta: 1 }).selected).toBe(
      1,
    );
    expect(reduce({ rows }, { type: "swarm_moved", delta: -1 }).selected).toBe(
      0,
    );
    expect(
      reduce({ rows, mode: "add" }, { type: "swarm_moved", delta: 1 }).selected,
    ).toBe(0);
  });

  it("walks the add wizard and refuses to leave the label step empty", () => {
    let panel = reduce({}, { type: "swarm_add_started" });
    expect(panel.mode).toBe("add");
    expect(panel.form.step).toBe("kind");
    panel = reduce(
      panel,
      { type: "swarm_form_kind_set", kind: "discord" },
      { type: "swarm_form_next" },
    );
    expect(panel.form).toMatchObject({ kind: "discord", step: "label" });
    // Empty label: stays put.
    panel = reduce(panel, { type: "swarm_form_next" });
    expect(panel.form.step).toBe("label");
    panel = reduce(
      panel,
      { type: "swarm_form_typed", text: "Ops" },
      { type: "swarm_form_next" },
      { type: "swarm_form_typed", text: "deploys" },
      { type: "swarm_form_next" },
      { type: "swarm_form_typed", text: "tok" },
      { type: "swarm_form_next" },
      { type: "swarm_form_typed", text: "42" },
    );
    expect(panel.form).toMatchObject({
      step: "owner",
      label: "Ops",
      role: "deploys",
      token: "tok",
      owner: "42",
    });
    // Past the last step nothing changes — the keyboard layer submits.
    expect(reduce(panel, { type: "swarm_form_next" }).form.step).toBe("owner");
    // Back walks steps, and off the first step closes the wizard.
    panel = reduce(panel, { type: "swarm_form_back" });
    expect(panel.form.step).toBe("token");
    panel = reduce(
      { ...panel, form: { ...panel.form, step: "kind" } },
      { type: "swarm_form_back" },
    );
    expect(panel.mode).toBe("list");
  });

  it("opens edit and remove for units only", () => {
    const rows = [PRIMARY, row()];
    expect(
      reduce({ rows, selected: 0 }, { type: "swarm_edit_started" }).mode,
    ).toBe("list");
    expect(
      reduce({ rows, selected: 0 }, { type: "swarm_remove_started" }).mode,
    ).toBe("list");
    expect(
      reduce({ rows, selected: 1 }, { type: "swarm_edit_started" }).mode,
    ).toBe("edit");
    expect(
      reduce({ rows, selected: 1 }, { type: "swarm_remove_started" }).mode,
    ).toBe("remove");
  });

  it("edit view: moves fields, starts typing empty, cancels typing before leaving", () => {
    const rows = [row()];
    let panel = reduce(
      { rows, mode: "edit" },
      { type: "swarm_edit_field_moved", delta: 2 },
    );
    expect(panel.editField).toBe("owner");
    panel = reduce(
      panel,
      { type: "swarm_edit_typing_started" },
      { type: "swarm_edit_typed", text: "42" },
    );
    expect(panel.editBuffer).toBe("42");
    // Fields do not move while typing.
    expect(
      reduce(panel, { type: "swarm_edit_field_moved", delta: 1 }).editField,
    ).toBe("owner");
    panel = reduce(panel, { type: "swarm_cancelled" });
    expect(panel).toMatchObject({ mode: "edit", editBuffer: null });
    panel = reduce(panel, { type: "swarm_cancelled" });
    expect(panel.mode).toBe("list");
  });

  it("a settled action closes the wizard on success and keeps it open on error", () => {
    // Found by driving the real UI: a typo in the last field used to
    // throw away the whole form, pasted bot token included.
    const ok = reduce(
      {
        mode: "add",
        form: {
          step: "owner",
          kind: "telegram",
          label: "Ops",
          role: "",
          token: "t",
          owner: "",
        },
      },
      { type: "swarm_action_started" },
      { type: "swarm_action_settled", message: "Ops added" },
    );
    expect(ok).toMatchObject({
      mode: "list",
      busy: false,
      message: "Ops added",
    });
    expect(ok.form.label).toBe("");
    const bad = reduce(
      {
        mode: "add",
        form: {
          step: "owner",
          kind: "telegram",
          label: "Ops",
          role: "",
          token: "t",
          owner: "x",
        },
      },
      { type: "swarm_action_settled", error: "owner id must be numeric" },
    );
    // Still in the wizard, on the rejected step, with every value intact.
    expect(bad).toMatchObject({
      mode: "add",
      lastError: "owner id must be numeric",
    });
    expect(bad.form).toMatchObject({
      step: "owner",
      label: "Ops",
      token: "t",
      owner: "x",
    });
    const edited = reduce(
      { mode: "edit", editBuffer: "x", rows: [row()] },
      { type: "swarm_action_settled", message: "label saved" },
    );
    expect(edited).toMatchObject({
      mode: "edit",
      editBuffer: null,
      message: "label saved",
    });
  });
});

describe("typed input survives batched keypresses", () => {
  // Found by holding backspace in the real UI: actions used to carry a
  // value computed from the state the key handler saw, so a burst of
  // keys handled against one render collapsed into a single edit.
  it("appends every keystroke of a burst", () => {
    const panel = reduce(
      {
        mode: "add",
        form: {
          step: "label",
          kind: "telegram",
          label: "",
          role: "",
          token: "",
          owner: "",
        },
      },
      ...["O", "p", "s"].map((text) => ({ type: "swarm_form_typed", text })),
    );
    expect(panel.form.label).toBe("Ops");
  });

  it("erases one character per backspace, in the form and in the editor", () => {
    const form = reduce(
      {
        mode: "add",
        form: {
          step: "owner",
          kind: "telegram",
          label: "Ops",
          role: "",
          token: "",
          owner: "@name",
        },
      },
      ...Array.from({ length: 4 }, () => ({ type: "swarm_form_backspace" })),
    );
    expect(form.form.owner).toBe("@");
    const editor = reduce(
      { mode: "edit", rows: [row()], editField: "owner", editBuffer: "12345" },
      ...Array.from({ length: 3 }, () => ({ type: "swarm_edit_backspace" })),
    );
    expect(editor.editBuffer).toBe("12");
  });

  it("treats an astral character as one keystroke", () => {
    const panel = reduce(
      {
        mode: "add",
        form: {
          step: "label",
          kind: "telegram",
          label: "Ops 🐝",
          role: "",
          token: "",
          owner: "",
        },
      },
      { type: "swarm_form_backspace" },
    );
    expect(panel.form.label).toBe("Ops ");
  });
});

describe("aliveSwarmCount", () => {
  it("counts bots that are on, hold a token, and are not down", () => {
    expect(
      aliveSwarmCount([
        row(),
        row({ id: "off", enabled: false }),
        row({ id: "no-token", hasToken: false }),
        // A row that reads "down: 401" must not have a critter running
        // for it — the strip would contradict the list above it.
        row({ id: "broken", state: "down", lastError: "401" }),
        PRIMARY,
      ]),
    ).toBe(2);
  });
});
