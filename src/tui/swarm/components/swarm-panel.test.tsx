import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";

import { createInitialSwarmPanelState, type SwarmPanelState, type SwarmRow } from "../swarm-panel-state.js";
import { SwarmPanel } from "./swarm-panel.js";

function row(over: Partial<SwarmRow> = {}): SwarmRow {
  return {
    id: "ops",
    kind: "telegram",
    primary: false,
    label: "Ops",
    role: "deploys",
    enabled: true,
    hasToken: true,
    ownerUserId: "42",
    state: "up",
    lastError: null,
    botUsername: "ops_bot",
    pairing: null,
    ...over,
  };
}

function panelOf(over: Partial<SwarmPanelState> = {}): SwarmPanelState {
  return {
    ...createInitialSwarmPanelState(),
    rows: [
      row({ id: "primary:telegram", primary: true, label: "Telegram", role: "primary", botUsername: null }),
      row(),
      row({
        id: "guild",
        kind: "discord",
        label: "Guild",
        enabled: false,
        hasToken: false,
        state: "disabled",
        botUsername: null,
      }),
    ],
    ...over,
  };
}

const flat = (s: string | undefined): string => (s ?? "").replace(/\s+/g, " ");

describe("SwarmPanel", () => {
  it("lists every bot with kind, state and role, primaries first", () => {
    const { lastFrame } = render(<SwarmPanel panel={panelOf()} animate={false} width={90} />);
    const out = flat(lastFrame());
    expect(out).toContain("Swarm 3 bots · 2 up");
    expect(out.indexOf("Telegram")).toBeLessThan(out.indexOf("Ops"));
    expect(out).toContain("[tg] Ops @ops_bot up · deploys");
    expect(out).toContain("[dc] Guild off");
    expect(out).toContain("primaries are managed in /integrations");
  });

  it("draws the hatchery when there is room, with one critter per live bot", () => {
    const tall = render(<SwarmPanel panel={panelOf()} animate={false} width={90} maxRows={14} />);
    const frame = tall.lastFrame() ?? "";
    // Half-block pixels only come from the strip.
    expect(frame).toMatch(/[▀▄]/);
    const short = render(<SwarmPanel panel={panelOf()} animate={false} width={90} maxRows={6} />);
    expect(short.lastFrame() ?? "").not.toMatch(/[▀▄]/);
  });

  it("masks the token while it is being typed in the wizard", () => {
    const panel = panelOf({
      mode: "add",
      form: { step: "token", kind: "telegram", label: "Ops", role: "", token: "secret", owner: "" },
    });
    const out = flat(render(<SwarmPanel panel={panel} animate={false} width={90} />).lastFrame());
    expect(out).toContain("Add a bot step 4/5");
    expect(out).toContain("••••••");
    expect(out).not.toContain("secret");
  });

  it("shows the detail view with the token masked and the pairing countdown in the list", () => {
    const detail = panelOf({ mode: "edit", selected: 1, editField: "owner" });
    const out = flat(render(<SwarmPanel panel={detail} animate={false} width={90} />).lastFrame());
    expect(out).toContain("> Owner id 42");
    expect(out).toContain("Bot token ••••••••");
    const pairing = panelOf({
      rows: [row({ ownerUserId: null, pairing: { active: true, secondsLeft: 41 } })],
    });
    expect(flat(render(<SwarmPanel panel={pairing} animate={false} width={90} />).lastFrame())).toContain(
      "pairing… 41s",
    );
  });

  it("surfaces errors and messages above the list", () => {
    const panel = panelOf({ lastError: "set a bot token first", message: "Ops added" });
    const out = flat(render(<SwarmPanel panel={panel} animate={false} width={90} />).lastFrame());
    expect(out).toContain("! set a bot token first");
    expect(out).toContain("Ops added");
  });
});
