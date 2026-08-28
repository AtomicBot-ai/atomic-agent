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
  /** Clicks the Tasks header's `+ new` chip delivered to the host. */
  taskNews: number[];
  unmount: () => void;
} {
  const bus = makeTuiEventBus();
  const mouse = makeMouseSource();
  const deleted: string[] = [];
  const copied: string[] = [];
  const taskNews: number[] = [];
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
        onTaskNewRequested: () => taskNews.push(taskNews.length),
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
    taskNews,
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

describe("TuiApp mouse", () => {
  // #165 was written against the Run / Observe / Manage pill strip and the
  // sub-tab strip. #170 replaced both with a breadcrumb plus one menu, so
  // the click target that used to switch sections now *opens the menu* —
  // the same thing ctrl+p does. Navigating from there is the menu's own
  // job and is covered by `menu-behaviour.test.ts`.
  it("opens the menu when the breadcrumb is clicked", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("R U N"), "the Run screen");
    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "R U N"),
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
    await waitUntil(() => app.frame().includes("R U N"), "the Run screen");
    const before = app.frame();
    app.mouse.emit(click(0, 0));
    await delay(150);
    expect(app.frame()).toBe(before);
    app.unmount();
  });

  it("places the editor caret where the prompt is clicked", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("R U N"), "the Run screen");
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

  it("takes the keyboard back from the rail when the prompt is clicked", async () => {
    // Tab parks focus on the rail, where ↑/↓ walk the session list. A
    // click on the input has to mean "type here" — otherwise the caret
    // moves to a field the keys still do not reach.
    const app = mountApp();
    await waitUntil(() => app.frame().includes("R U N"), "the Run screen");
    app.stdin.write("\t");
    await waitUntil(
      () => app.frame().includes("SESSIONS"),
      "the rail on screen",
    );
    // Click, then try to type: the proof is that a character lands in the
    // buffer instead of being swallowed by the rail's key handler. The
    // pair is retried together because a click that arrives before the
    // target's registration effect has flushed simply does nothing —
    // clicking once and then asserting is what made this flaky under a
    // loaded test run.
    let landed = false;
    for (let attempt = 0; attempt < 25 && !landed; attempt += 1) {
      const at = locate(app.frame(), "❯");
      app.mouse.emit(click(at.x + 2, at.y));
      await delay(60);
      app.stdin.write("z");
      await delay(60);
      landed = app.frame().includes("z");
    }
    expect(landed).toBe(true);
    app.unmount();
  });

  it("clamps a click past the end of a line to the line end", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("R U N"), "the Run screen");
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

  /**
   * The menu is the app's one modal surface, so its mouse rules are the
   * ones an operator will try first: spin to scroll, click a row to run
   * it, click away to dismiss.
   */
  describe("operator menu", () => {
    const openMenu = async (app: ReturnType<typeof mountApp>): Promise<void> => {
      await waitUntil(() => app.frame().includes("R U N"), "the Run screen");
      app.stdin.write(String.fromCharCode(16));
      await waitUntil(() => app.frame().includes("MENU"), "the menu");
    };
    /** The row the ▶ marker is sitting on. */
    const selected = (app: ReturnType<typeof mountApp>): string =>
      app
        .frame()
        .split("\n")
        .find((line) => line.includes("▶"))
        ?.replace(/.*▶\s*/, "")
        .trim() ?? "";

    it("walks the cursor with the wheel", async () => {
      const app = mountApp();
      await openMenu(app);
      expect(selected(app)).toContain("Run");
      const at = locate(app.frame(), "MENU");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        app.mouse.emit(wheel("down", at.x + 4, at.y + 3));
        await delay(40);
        if (!selected(app).includes("Run")) break;
      }
      expect(selected(app)).toContain("Observe");
      // And back up again: one notch, one row, the same as the keys.
      app.mouse.emit(wheel("up", at.x + 4, at.y + 3));
      await waitUntil(() => selected(app).includes("Run"), "the cursor back on Run");
      app.unmount();
    });

    it("runs the row that is clicked", async () => {
      const app = mountApp();
      await openMenu(app);
      await clickUntil(
        app.mouse,
        () => {
          // `Run` is a destination, so activating it closes the menu and
          // lands somewhere. A submenu row would only open the submenu,
          // which is not the thing under test here.
          const at = locate(app.frame(), "Run  ");
          return { x: at.x + 2, y: at.y };
        },
        () => !app.frame().includes("MENU"),
        "click a menu row",
      );
      // Acting closes the menu — the row ran rather than just selecting.
      expect(app.frame()).not.toContain("MENU");
      app.unmount();
    });

    it("closes when the click lands outside the panel", async () => {
      const app = mountApp();
      await openMenu(app);
      // Top-left of the viewport: the status bar, well clear of a popup
      // that is centred in the pane.
      await clickUntil(
        app.mouse,
        () => ({ x: 0, y: 0 }),
        () => !app.frame().includes("MENU"),
        "click outside the menu",
      );
      expect(app.frame()).not.toContain("MENU");
      app.unmount();
    });

    it("stays open when the click lands on the panel's own chrome", async () => {
      const app = mountApp();
      await openMenu(app);
      // The title row is inside the popup: clicking it must not fall
      // through to the backdrop.
      const at = locate(app.frame(), "MENU");
      app.mouse.emit(click(at.x, at.y));
      await delay(120);
      expect(app.frame()).toContain("MENU");
      app.unmount();
    });
  });

  /**
   * The rail's close mark and the confirmation it opens. Deleting a
   * thread is the most destructive thing the mouse can reach, so the
   * path from click to gone is pinned end to end.
   */
  describe("session delete", () => {
    const openDialog = async (
      app: ReturnType<typeof mountApp>,
    ): Promise<void> => {
      await waitUntil(() => app.frame().includes("R U N"), "the Run screen");
      app.seedSessions();
      await waitUntil(() => app.frame().includes("first thread"), "the rail rows");
      app.stdin.write("\t");
      await waitUntil(() => app.frame().includes("[x]"), "the selected row");
      await clickUntil(
        app.mouse,
        () => {
          const at = locate(app.frame(), "[x]");
          return { x: at.x + 1, y: at.y };
        },
        () => app.frame().includes("DELETE THE SESSION?"),
        "click the close mark",
      );
    };

    it("opens the confirmation from the row's close mark", async () => {
      const app = mountApp();
      await openDialog(app);
      expect(app.frame()).toContain("DELETE THE SESSION?");
      expect(app.frame()).toContain("Cancel");
      expect(app.deleted).toEqual([]);
      app.unmount();
    });

    it("deletes only when Yes is clicked", async () => {
      const app = mountApp();
      await openDialog(app);
      // Retry against the OUTCOME, not against the dialog disappearing:
      // a click that arrives before the button's registration effect
      // has flushed falls through to the backdrop, which dismisses the
      // dialog — that would satisfy a "dialog is gone" predicate while
      // deleting nothing. Re-open and try again until something is
      // actually deleted.
      for (let attempt = 0; attempt < 20 && app.deleted.length === 0; attempt += 1) {
        if (!app.frame().includes("DELETE THE SESSION?")) {
          await openDialog(app);
        }
        // The dialog's buttons register their targets in an effect that
        // flushes a frame after the panel first paints; clicking inside
        // that window falls through to the backdrop.
        await delay(150);
        const at = locate(app.frame(), "Yes");
        app.mouse.emit(click(at.x + 1, at.y));
        await delay(80);
      }
      expect(app.deleted).toEqual(["s-1"]);
      expect(app.frame()).not.toContain("DELETE THE SESSION?");
      app.unmount();
    });

    it("cancels on a click outside the panel, deleting nothing", async () => {
      const app = mountApp();
      await openDialog(app);
      await clickUntil(
        app.mouse,
        () => ({ x: 0, y: 0 }),
        () => !app.frame().includes("DELETE THE SESSION?"),
        "click outside the dialog",
      );
      expect(app.deleted).toEqual([]);
      app.unmount();
    });
  });

  it("requests a new task from the Tasks header's + new chip", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("TASKS"), "the rail on screen");
    // Two `+ new` chips are on screen — the Sessions header owns the
    // first, so the one under test is the chip sharing a line with the
    // TASKS label.
    await clickUntil(
      app.mouse,
      () => {
        const lines = app.frame().split("\n");
        for (const [y, line] of lines.entries()) {
          if (!line.includes("TASKS")) continue;
          const x = line.indexOf("+ new");
          if (x !== -1) return { x: x + 1, y };
        }
        throw new Error(`no "+ new" on the TASKS line:\n${app.frame()}`);
      },
      () => app.taskNews.length > 0,
      "click the Tasks + new chip",
    );
    expect(app.taskNews.length).toBeGreaterThan(0);
    app.unmount();
  });

  it("puts a start-page tip in the composer when it is clicked", async () => {
    // The rows are suggestions, not buttons: the command lands in the
    // buffer with a trailing space and Enter stays the operator's.
    const app = mountApp();
    await waitUntil(() => app.frame().includes("/sessions"), "the start page");
    await delay(150);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const at = locate(app.frame(), "/sessions");
      app.mouse.emit(click(at.x + 2, at.y));
      await delay(70);
      if (app.frame().includes("❯ /sessions")) break;
    }
    expect(app.frame()).toContain("❯ /sessions");
    // Seeded, not run: no palette over the buffer we just filled.
    expect(app.frame()).not.toContain("/dump");
    app.unmount();
  });

  it("selects composer text by dragging, and copies it with ctrl+c", async () => {
    // The terminal stops doing its own drag-to-select the moment mouse
    // reporting is on, so this gesture is the replacement for it.
    const app = mountApp();
    await waitUntil(() => app.frame().includes("R U N"), "the Run screen");
    app.stdin.write("hello world");
    await waitUntil(() => app.frame().includes("hello world"), "the buffer");
    await delay(150);

    const at = locate(app.frame(), "hello world");
    // Press on "w", drag to the end of the word, release.
    app.mouse.emit(click(at.x + 6, at.y));
    await delay(60);
    app.mouse.emit(drag(at.x + 9, at.y));
    await delay(60);
    app.mouse.emit(release(at.x + 9, at.y));
    await delay(60);

    app.stdin.write(String.fromCharCode(3));
    await delay(120);
    expect(app.copied).toEqual(["wor"]);
    // The quit chord must not have been armed by that Ctrl+C.
    expect(app.frame()).not.toContain("press again to quit");
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
