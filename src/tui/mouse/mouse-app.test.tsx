import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "../tui-app.js";
import type { TuiSessionInfo } from "../tui-state.js";
import { makeMouseSource, type MouseSourceEmitter } from "./mouse-source.js";
import type { TuiMouseEvent } from "./mouse-event.js";

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
    unmount,
  };
}

describe("TuiApp mouse", () => {
  // #165 was written against the Run / Observe / Manage pill strip and the
  // sub-tab strip. #170 replaced both with a breadcrumb plus one menu, so
  // the click target that used to switch sections now *opens the menu* —
  // the same thing ctrl+p does. Navigating from there is the menu's own
  // job and is covered by `menu-behaviour.test.ts`.
  it("opens the menu when the breadcrumb is clicked", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("Run"), "the Run screen");
    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "Run"),
      () => app.frame().includes("Observe"),
      "click on the breadcrumb",
    );
    // The menu lists every destination, so Observe/Manage become visible
    // only once it is open.
    expect(app.frame()).toContain("Observe");
    expect(app.frame()).toContain("Manage");
    app.unmount();
  });

  it("ignores a click that lands on no target", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("Run"), "the Run screen");
    const before = app.frame();
    app.mouse.emit(click(0, 0));
    await delay(150);
    expect(app.frame()).toBe(before);
    app.unmount();
  });

  it("places the editor caret where the prompt is clicked", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("Run"), "the Run screen");
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
    await waitUntil(() => app.frame().includes("Run"), "the Run screen");
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
    const marker = (name: string): string => {
      const line = app
        .frame()
        .split("\n")
        .find((candidate) => candidate.includes(name));
      return line?.trimStart().slice(0, 1) ?? "";
    };
    await waitUntil(() => marker("alpha-skill") === "▸", "the seeded skill rows");
    for (let attempt = 0; attempt < 40; attempt += 1) {
      app.mouse.emit(wheel("down", 10, 6));
      await delay(50);
      if (marker("beta-skill") === "▸") break;
    }
    expect(marker("beta-skill")).toBe("▸");
    app.unmount();
  });

  it("routes a click to a list row and moves the cursor there", async () => {
    const app = mountApp();
    app.openSkillsPanel();
    const marker = (name: string): string => {
      const line = app
        .frame()
        .split("\n")
        .find((candidate) => candidate.includes(name));
      return line?.trimStart().slice(0, 1) ?? "";
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
