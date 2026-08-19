import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "../tui-app.js";
import type { TuiSessionInfo } from "../tui-state.js";
import { makeMouseSource, type MouseSourceEmitter } from "./mouse-source.js";
import type { TuiMouseEvent } from "./mouse-event.js";
import { computeSidebarWidth } from "../layout.js";

const SESSION: TuiSessionInfo = {
  sessionId: null,
  workingDir: "/tmp/mouse",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

function noopCallbacks(): TuiAppCallbacks {
  return {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {},
    onMessageSubmitted: () => {},
  };
}

function strip(value: string): string {
  return value
    .replace(/\u001B\[[0-9;]*m/g, "")
    .replace(/\u001B\]8;;[^]*/g, "");
}

/**
 * Screen position of `needle` in the rendered frame. Stripping SGR
 * codes leaves the visual grid intact, so the returned column/row are
 * the same cells the terminal would report for a click.
 */
function locate(frame: string, needle: string): { x: number; y: number } {
  const lines = strip(frame).split("\n");
  for (const [y, line] of lines.entries()) {
    const x = line.indexOf(needle);
    if (x !== -1) return { x, y };
  }
  throw new Error(`"${needle}" is not on screen:\n${strip(frame)}`);
}

function click(x: number, y: number): TuiMouseEvent {
  return {
    kind: "press",
    button: "left",
    wheel: null,
    x,
    y,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

function wheel(direction: "up" | "down", x: number, y: number): TuiMouseEvent {
  return {
    kind: "wheel",
    button: "none",
    wheel: direction,
    x,
    y,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ink commits frames on its own throttle (`maxFps` 30) and React
 * flushes the effects that register click targets after that commit, so
 * a freshly rendered target is not clickable for a frame or two. Under a
 * loaded test runner that window stretches, which is why nothing here
 * waits a fixed number of milliseconds: `waitUntil` polls the rendered
 * frame, and `clickUntil` re-sends the click until it takes effect —
 * the terminal equivalent of a user who clicks again when the first one
 * lands mid-repaint.
 */
async function waitUntil(
  condition: () => boolean,
  describe: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${describe}`);
}

async function clickUntil(
  mouse: MouseSourceEmitter,
  point: () => { x: number; y: number },
  settled: () => boolean,
  describe: string,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { x, y } = point();
    mouse.emit(click(x, y));
    await delay(50);
    if (settled()) return;
  }
  throw new Error(`click never took effect: ${describe}`);
}

function mountApp(): {
  frame: () => string;
  mouse: MouseSourceEmitter;
  stdin: { write: (data: string) => void };
  openSkillsPanel: () => void;
  say: (text: string) => void;
  unmount: () => void;
} {
  const bus = makeTuiEventBus();
  const mouse = makeMouseSource();
  const { lastFrame, stdin, unmount } = render(
    <TuiApp
      session={SESSION}
      bus={bus}
      callbacks={noopCallbacks()}
      mouse={mouse}
    />,
  );
  return {
    frame: () => strip(lastFrame() ?? ""),
    mouse,
    stdin,
    openSkillsPanel: () => {
      bus.emit({ type: "ui_mode_set", mode: "debug" });
      bus.emit({ type: "tab_changed", tab: "skills" });
      bus.emit({
        type: "skills_refreshed",
        at: 0,
      rows: [
        {
          name: "alpha-skill",
          description: "first",
          version: "1.0.0",
          source: "builtin",
          disabled: false,
        },
        {
          name: "beta-skill",
          description: "second",
          version: "1.0.0",
          source: "builtin",
          disabled: false,
        },
      ],
      });
    },
    say: (text) => bus.emit({ type: "system_message", text }),
    unmount,
  };
}

describe("TuiApp mouse", () => {
  it("opens the menu when the rail's Menu button is clicked", async () => {
    // The pills are gone and the top bar with them; the rail's Menu
    // button is the mouse route into navigation. Without it the mouse
    // would have no way to change section at all.
    const app = mountApp();
    await waitUntil(() => app.frame().includes("llama.cpp"), "the Run screen");
    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "Menu"),
      () => app.frame().includes("GO"),
      "click on the rail's Menu button",
    );
    expect(app.frame()).toContain("Menu");
    app.unmount();
  });

  it("navigates when a menu row is clicked", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("llama.cpp"), "the Run screen");
    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "Menu"),
      () => app.frame().includes("GO"),
      "click on the rail's Menu button",
    );
    // One click acts on a menu row — the menu is the one surface where
    // the two-step select-then-activate rule would be the surprise.
    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "Toggle debug pane"),
      () => app.frame().includes("▸ Feed"),
      "click on a menu row",
    );
    expect(app.frame()).toContain("▸ Feed");
    app.unmount();
  });

  it("switches sub-tab when a tab label is clicked", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("llama.cpp"), "the Run screen");
    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "Menu"),
      () => app.frame().includes("GO"),
      "click on the rail's Menu button",
    );
    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "Toggle debug pane"),
      () => app.frame().includes("▸ Feed"),
      "click on a menu row",
    );
    await waitUntil(() => app.frame().includes("Logs"), "the Observe sub-tabs");
    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "Logs"),
      () => app.frame().includes("▸ Logs"),
      "click on the Logs sub-tab",
    );
    expect(app.frame()).toContain("▸ Logs");
    app.unmount();
  });

  it("reaches the per-message copy button through the whole app", async () => {
    // Proves the button survives the real tree — the chat viewport's
    // `overflow: hidden` clip, the base-layer wheel target covering the
    // entire content area, and the layer floor. The badge says "failed"
    // because no `ClipboardProvider` is mounted and the default writer
    // refuses to act on a non-TTY stdout, which is exactly the guard
    // that keeps the suite off the developer's real clipboard.
    const app = mountApp();
    await waitUntil(() => app.frame().includes("llama.cpp"), "the Run screen");
    // The bus subscription is installed by an effect; emitting before it
    // runs drops the event on the floor.
    await delay(50);
    app.say("a message worth copying");
    await waitUntil(() => app.frame().includes("[copy]"), "the copy button");
    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "[copy]"),
      () => app.frame().includes("[copy failed]"),
      "click on the message's copy button",
    );
    expect(app.frame()).toContain("[copy failed]");
    app.unmount();
  });

  it("ignores a click that lands on no target", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("llama.cpp"), "the Run screen");
    const before = app.frame();
    app.mouse.emit(click(0, 0));
    await delay(150);
    expect(app.frame()).toBe(before);
    app.unmount();
  });

  it("places the editor caret where the prompt is clicked", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("llama.cpp"), "the Run screen");
    app.stdin.write("hello");
    await waitUntil(() => app.frame().includes("hello"), "the typed buffer");
    // Click the second "l" (index 3) then type: the character has to land
    // at the caret, not at the end of the buffer.
    await clickUntil(
      app.mouse,
      () => {
        const at = locate(app.frame(), "hello");
        return { x: at.x + 3, y: at.y };
      },
      () => true,
      "click inside the prompt",
    );
    app.stdin.write("X");
    await waitUntil(
      () => app.frame().includes("helXlo"),
      "the character inserted at the clicked caret",
    );
    expect(app.frame()).toContain("helXlo");
    app.unmount();
  });

  it("clamps a click past the end of a line to the line end", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("llama.cpp"), "the Run screen");
    app.stdin.write("hi");
    await waitUntil(() => app.frame().includes("hi"), "the typed buffer");
    await clickUntil(
      app.mouse,
      () => {
        const at = locate(app.frame(), "hi");
        return { x: at.x + 30, y: at.y };
      },
      () => true,
      "click past the end of the line",
    );
    app.stdin.write("!");
    await waitUntil(
      () => app.frame().includes("hi!"),
      "the character appended at the clamped caret",
    );
    expect(app.frame()).toContain("hi!");
    app.unmount();
  });

  it("moves a panel cursor with the wheel", async () => {
    const app = mountApp();
    app.openSkillsPanel();
    // The rail shares every terminal row with the panel, so the first
    // glyph on a line belongs to the rail, not to the row. Slice the
    // rail off first — ink-testing-library pins stdout at 100 columns,
    // which is the width the rail sizes itself against.
    const railColumns = computeSidebarWidth(100);
    const marker = (name: string): string => {
      const line = app
        .frame()
        .split("\n")
        .find((candidate) => candidate.includes(name));
      if (!line) return "";
      return line.slice(railColumns).trimStart().slice(0, 1);
    };
    await waitUntil(() => marker("alpha-skill") === "▸", "the seeded skill rows");
    for (let attempt = 0; attempt < 40; attempt += 1) {
      // Aim at the panel column: x=10 is inside the rail now.
      app.mouse.emit(wheel("down", 60, 6));
      await delay(50);
      if (marker("beta-skill") === "▸") break;
    }
    expect(marker("beta-skill")).toBe("▸");
    app.unmount();
  });

  it("routes a click to a list row and moves the cursor there", async () => {
    const app = mountApp();
    app.openSkillsPanel();
    // The rail shares every terminal row with the panel, so the first
    // glyph on a line belongs to the rail, not to the row. Slice the
    // rail off first — ink-testing-library pins stdout at 100 columns,
    // which is the width the rail sizes itself against.
    const railColumns = computeSidebarWidth(100);
    const marker = (name: string): string => {
      const line = app
        .frame()
        .split("\n")
        .find((candidate) => candidate.includes(name));
      if (!line) return "";
      return line.slice(railColumns).trimStart().slice(0, 1);
    };
    await waitUntil(() => marker("alpha-skill") === "▸", "the seeded skill rows");
    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "beta-skill"),
      () => marker("beta-skill") === "▸",
      "click on the beta-skill row",
    );
    expect(marker("beta-skill")).toBe("▸");
    expect(marker("alpha-skill")).not.toBe("▸");
    app.unmount();
  });
});

describe("TuiApp mouse — run modes", () => {
  it("asks for the run mode a clicked pill names", async () => {
    const asked: string[] = [];
    const bus = makeTuiEventBus();
    const mouse = makeMouseSource();
    const { lastFrame, unmount } = render(
      <TuiApp
        session={SESSION}
        bus={bus}
        callbacks={{
          ...noopCallbacks(),
          onRunModeChangeRequested: (mode) => asked.push(mode),
        }}
        mouse={mouse}
      />,
    );
    const frame = (): string => strip(lastFrame() ?? "");
    await waitUntil(() => frame().includes("Fusion"), "the run-mode strip");
    await clickUntil(
      mouse,
      () => locate(frame(), "Fusion"),
      () => asked.includes("fusion"),
      "click on the Fusion pill",
    );
    expect(asked).toContain("fusion");
    unmount();
  });

  it("opens the dial when the pill already in effect is clicked", async () => {
    // Re-applying the mode you are already in would be a wasted provider
    // swap, and on Fusion the dial is otherwise unreachable by mouse.
    const app = mountApp();
    await waitUntil(() => app.frame().includes("Local"), "the run-mode strip");
    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "Local"),
      () => app.frame().includes("cloud share"),
      "click on the active pill",
    );
    expect(app.frame()).toContain("Run mode");
    expect(app.frame()).toContain("cloud share");
    app.unmount();
  });
});
