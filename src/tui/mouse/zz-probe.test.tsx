import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ClipboardProvider } from "../clipboard/clipboard-context.js";
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

/** A motion report sent while the left button is held (DECSET 1002). */
function drag(x: number, y: number): TuiMouseEvent {
  return {
    kind: "motion",
    button: "left",
    wheel: null,
    x,
    y,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

function release(x: number, y: number): TuiMouseEvent {
  return {
    kind: "release",
    button: "none",
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
  /** Text the app asked the clipboard to hold. */
  copied: string[];
  mouse: MouseSourceEmitter;
  stdin: { write: (data: string) => void };
  openSkillsPanel: () => void;
  /** Put two threads in the rail so its rows are clickable. */
  seedSessions: () => void;
  /** Session ids the app asked the host to delete. */
  deleted: string[];
  unmount: () => void;
} {
  const bus = makeTuiEventBus();
  const mouse = makeMouseSource();
  const deleted: string[] = [];
  const copied: string[] = [];
  const clipboard = {
    copy: async (text: string) => {
      copied.push(text);
      return true;
    },
  };
  const { lastFrame, stdin, unmount } = render(
    <ClipboardProvider writer={clipboard}>
    <TuiApp
      session={SESSION}
      bus={bus}
      callbacks={{
        ...noopCallbacks(),
        onSessionDeleteConfirmed: (sessionId) => deleted.push(sessionId),
      }}
      mouse={mouse}
    />
    </ClipboardProvider>,
  );
  return {
    frame: () => strip(lastFrame() ?? ""),
    mouse,
    stdin,
    deleted,
    copied,
    seedSessions: () => {
      bus.emit({
        type: "recent_sessions_updated",
        sessions: [
          {
            sessionId: "s-1",
            workingDir: "/tmp/smoke",
            turnCount: 1,
            stepCount: 1,
            updatedAt: 2,
            preview: "first thread",
          },
          {
            sessionId: "s-2",
            workingDir: "/tmp/smoke",
            turnCount: 1,
            stepCount: 1,
            updatedAt: 1,
            preview: "second thread",
          },
        ],
      });
    },
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

describe("PROBE3", () => {
  const sel = (app: { frame: () => string }): string =>
    app.frame().split("\n").find((l) => l.includes("▶"))?.replace(/.*▶\s*/, "").trim() ?? "";

  it("P2a: 3 notches WITH delays move 3 rows; 3 notches batched move 1", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("R U N"), "run screen");
    app.stdin.write(String.fromCharCode(16));
    await waitUntil(() => app.frame().includes("MENU"), "menu");
    await delay(300);
    const at = locate(app.frame(), "MENU");
    console.log("P2a start:", JSON.stringify(sel(app)));
    for (let i = 0; i < 3; i += 1) {
      app.mouse.emit(wheel("down", at.x + 4, at.y + 3));
      await delay(120);
      console.log("  spaced notch", i + 1, JSON.stringify(sel(app)));
    }
    app.unmount();
  });

  it("P2b: 3 notches batched", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("R U N"), "run screen");
    app.stdin.write(String.fromCharCode(16));
    await waitUntil(() => app.frame().includes("MENU"), "menu");
    await delay(300);
    const at = locate(app.frame(), "MENU");
    console.log("P2b start:", JSON.stringify(sel(app)));
    app.mouse.emit(wheel("down", at.x + 4, at.y + 3));
    app.mouse.emit(wheel("down", at.x + 4, at.y + 3));
    app.mouse.emit(wheel("down", at.x + 4, at.y + 3));
    await delay(400);
    console.log("P2b after 3 batched:", JSON.stringify(sel(app)));
    app.unmount();
  });

  it("P5: sidebar wheel, 3 batched notches", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("R U N"), "run screen");
    app.seedSessions();
    await waitUntil(() => app.frame().includes("first thread"), "rail");
    await delay(300);
    const row = locate(app.frame(), "first thread");
    const marked = () =>
      app.frame().split("\n").filter((l) => l.includes("thread")).join(" | ");
    console.log("P5 before:", marked());
    app.mouse.emit(wheel("down", row.x, row.y));
    app.mouse.emit(wheel("down", row.x, row.y));
    await delay(400);
    console.log("P5 after 2 batched:", marked());
    app.unmount();
  });
});
