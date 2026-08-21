import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "./tui-app.js";
import type { TuiSessionInfo } from "./tui-state.js";

/**
 * The composer belongs to the Run screen. Observe and Manage are for
 * watching and configuring; a prompt under a settings panel invites a
 * message nobody reads from there.
 *
 * The exception is a surface whose keyboard the composer owns while it
 * is open — most sharply the slash palette, which `handleAppKey`
 * refuses to close (`!state.slashPaletteOpen`), so unmounting the
 * composer under it would leave it with no way out at all.
 */
const SESSION: TuiSessionInfo = {
  sessionId: "s1",
  workingDir: "/tmp/smoke",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

const ESC = String.fromCharCode(27);
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 60));
const strip = (value: string): string =>
  value.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), "");

function callbacks(): TuiAppCallbacks {
  return {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {},
    onMessageSubmitted: () => {},
  };
}

/** The composer's own furniture: the caret and the Send control. */
const composerMarks = (frame: string): boolean =>
  frame.includes("send") && frame.includes("\u276f");

function mount() {
  const bus = makeTuiEventBus();
  const app = render(
    <TuiApp session={SESSION} bus={bus} callbacks={callbacks()} />,
  );
  return { bus, ...app, frame: () => strip(app.lastFrame() ?? "") };
}

describe("composer visibility", () => {
  it("is on screen on the Run screen", async () => {
    const app = mount();
    await settle();
    expect(composerMarks(app.frame())).toBe(true);
    app.unmount();
  });

  it("is gone on a Manage tab", async () => {
    const app = mount();
    await settle();
    app.bus.emit({ type: "ui_mode_set", mode: "debug" });
    app.bus.emit({ type: "tab_changed", tab: "tasks" });
    await settle();
    expect(app.frame()).toContain("Tasks");
    expect(composerMarks(app.frame())).toBe(false);
    app.unmount();
  });

  it("is gone on an Observe tab", async () => {
    const app = mount();
    await settle();
    app.bus.emit({ type: "ui_mode_set", mode: "debug" });
    app.bus.emit({ type: "tab_changed", tab: "feed" });
    await settle();
    expect(composerMarks(app.frame())).toBe(false);
    app.unmount();
  });

  it("comes back for the slash palette, which types into it", async () => {
    const app = mount();
    await settle();
    app.bus.emit({ type: "ui_mode_set", mode: "debug" });
    app.bus.emit({ type: "tab_changed", tab: "llm" });
    await settle();
    expect(composerMarks(app.frame())).toBe(false);

    app.bus.emit({ type: "slash_palette_opened", query: "" });
    await settle();
    expect(app.frame()).toContain("/help");
    expect(composerMarks(app.frame())).toBe(true);
    app.unmount();
  });

  it("Esc still returns to Run from an Observe tab", async () => {
    // This used to be the editor's job, through an `onEscape` it no
    // longer has there — the Observe tabs have no key layer of their
    // own, so `handlePanelEscape` never sees the keypress either.
    const app = mount();
    await settle();
    app.bus.emit({ type: "ui_mode_set", mode: "debug" });
    app.bus.emit({ type: "tab_changed", tab: "feed" });
    await settle();
    app.stdin.write(ESC);
    await settle();
    expect(composerMarks(app.frame())).toBe(true);
    expect(app.frame()).toContain("R U N");
    app.unmount();
  });
});
