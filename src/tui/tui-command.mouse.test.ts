/**
 * `/mouse on` has to reach the mounted tree.
 *
 * The toggle lives outside React — it reassigns a tracking controller and
 * writes escape sequences — while the thing that consumes clicks is a
 * prop fixed at mount. Gating that prop on the startup value made
 * `/mouse on` a no-op for any session that started with `tui.mouse:
 * false`: reporting turned on, the confirmation said so, and every click
 * was dropped. These tests boot `tuiCommand` far enough to capture the
 * props it hands `TuiApp` and then drive the toggle exactly as the slash
 * command does.
 *
 * `mouse-app.test.tsx` covers the other half of the chain (a source
 * event moving the real UI), so between the two the path from a byte on
 * stdin to a section change is closed.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureUserConfigFileSync,
  getConfig,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";
import type { TuiMouseEvent } from "./mouse/mouse-event.js";
import type { MouseSource } from "./mouse/mouse-source.js";
import { DEFAULT_SELECTION_WINDOW_MS } from "./mouse/selection-passthrough.js";
import type { TuiAction } from "./tui-action.js";

const inkRender = vi.hoisted(() => vi.fn());
const trackingCalls = vi.hoisted(() => ({ enabled: 0, disabled: 0, resumed: 0 }));
const orchestratorCalls = vi.hoisted(() => ({ quits: 0 }));

// `sea` is one of the few builtins Node only publishes under the
// `node:` prefix, and Vite's builtin check strips that prefix — so the
// bare import in `tui-command.ts` is unresolvable in the test runner.
// The restart handoff that uses it is not under test here.
vi.mock("node:sea", () => ({ isSea: () => false }));

vi.mock("ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ink")>()),
  render: inkRender,
}));

vi.mock("./alt-screen.js", () => ({
  enterAltScreen: () => ({ restore: () => {} }),
}));

vi.mock("./mouse/mouse-tracking.js", () => ({
  enableMouseTracking: () => {
    trackingCalls.enabled += 1;
    let suspended = false;
    return {
      disable: () => {
        trackingCalls.disabled += 1;
        suspended = false;
      },
      suspend: () => {
        suspended = true;
      },
      resume: () => {
        trackingCalls.resumed += 1;
        suspended = false;
      },
      isSuspended: () => suspended,
    };
  },
}));

vi.mock("../runtime/bootstrap.js", () => ({
  createAgentRuntime: async () => ({
    skillCatalog: [],
    approvals: { resolve: () => {} },
    config: { telegram: { enabled: false } },
  }),
}));

vi.mock("./chat-orchestrator.js", () => ({
  ChatOrchestrator: class {
    exitCode = 0;
    telegram = { forwardStatus: () => {} };
    localModels = { autoStartIfReady: async () => {} };
    start(): void {}
    quit(): void {
      orchestratorCalls.quits += 1;
    }
    async checkForUpdate(): Promise<void> {}
    async shutdown(): Promise<void> {}
  },
}));

/** SGR 1006 left-button press at 1-based (col, row). */
function sgrPress(col: number, row: number): Buffer {
  return Buffer.from(`\u001B[<0;${col};${row}M`);
}

/** SGR 1006 alt-modified left press — the other modifier trigger. */
function sgrAltPress(col: number, row: number): Buffer {
  return Buffer.from(`\u001B[<8;${col};${row}M`);
}

/** SGR 1006 shift-modified left press — the selection-window trigger. */
function sgrShiftPress(col: number, row: number): Buffer {
  return Buffer.from(`\u001B[<4;${col};${row}M`);
}

/**
 * Stands in for `process.stdin`: `tuiCommand` reads the real one, so the
 * test swaps in a stream it can push bytes through. `isTTY` also gets
 * the TUI past its non-interactive-stdin refusal.
 */
function makeFakeStdin(): NodeJS.ReadStream {
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return stdin;
}

interface Booted {
  readonly mouse: MouseSource | undefined;
  readonly setMouseEnabled: (next: boolean | null) => void;
  /**
   * The `onSelectionDragIntent` callback as `TuiApp` received it. The
   * mounted tree is mocked out here, so the drag-intent tracker that
   * would normally fire it is not running — tests invoke it directly,
   * exactly as the tracker does on an unclaimed drag.
   */
  readonly selectionDragIntent: () => void;
  readonly seen: TuiMouseEvent[];
  /** Every bus action emitted after mount — system messages included. */
  readonly actions: TuiAction[];
  /** Chat-bound `system_message` texts, in emit order. */
  readonly messages: string[];
  readonly stop: () => Promise<number>;
}

/**
 * Runs `tuiCommand` up to the point where Ink would mount, and returns
 * the mouse wiring it produced. `waitUntilExit` stays pending until
 * `stop()` so the toggle can be exercised against a live session.
 */
async function bootTui(args: string[] = []): Promise<Booted> {
  let releaseExit = (): void => {};
  const exited = new Promise<void>((resolve) => {
    releaseExit = resolve;
  });
  let props: Record<string, unknown> | null = null;
  inkRender.mockImplementation((element: { props: Record<string, unknown> }) => {
    props = element.props;
    return { waitUntilExit: () => exited, clear: () => {} };
  });

  const { tuiCommand } = await import("./tui-command.js");
  const finished = tuiCommand(["--skip-llama-setup", ...args]);
  for (let attempt = 0; props === null && attempt < 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (props === null) throw new Error("TuiApp never rendered");
  const captured = props as {
    mouse?: MouseSource;
    bus?: { subscribe(listener: (action: TuiAction) => void): () => void };
    callbacks: {
      onMouseSupportRequested?: (next: boolean | null) => void;
      onSelectionDragIntent?: () => void;
    };
  };

  const seen: TuiMouseEvent[] = [];
  captured.mouse?.subscribe((event) => seen.push(event));
  const actions: TuiAction[] = [];
  const messages: string[] = [];
  captured.bus?.subscribe((action) => {
    actions.push(action);
    if (action.type === "system_message") messages.push(action.text);
  });
  const setMouseEnabled = captured.callbacks.onMouseSupportRequested;
  if (!setMouseEnabled) throw new Error("onMouseSupportRequested not wired");
  const selectionDragIntent = captured.callbacks.onSelectionDragIntent;
  if (!selectionDragIntent) throw new Error("onSelectionDragIntent not wired");

  return {
    mouse: captured.mouse,
    setMouseEnabled,
    selectionDragIntent,
    seen,
    actions,
    messages,
    stop: async () => {
      releaseExit();
      return finished;
    },
  };
}

describe("tuiCommand mouse wiring", () => {
  let stateDir: string;
  let realStdin: PropertyDescriptor | undefined;
  let stdin: NodeJS.ReadStream;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "tui-mouse-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    trackingCalls.enabled = 0;
    trackingCalls.disabled = 0;
    trackingCalls.resumed = 0;
    stdin = makeFakeStdin();
    realStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", {
      value: stdin,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (realStdin) Object.defineProperty(process, "stdin", realStdin);
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.resetModules();
  });

  function writeMouseConfig(mouse: boolean): void {
    const path = getConfig().paths.userConfigFile;
    const file = ensureUserConfigFileSync(path);
    writeUserConfigFileSync(path, {
      ...file,
      tui: { ...file.tui, theme: "dark", mouse },
    });
    resetConfigCache();
  }

  it("hands TuiApp a mouse source even when mouse support starts off", async () => {
    writeMouseConfig(false);
    const app = await bootTui();
    expect(app.mouse).toBeDefined();
    expect(trackingCalls.enabled).toBe(0);
    await app.stop();
  });

  it("delivers clicks to the mounted source after /mouse on", async () => {
    writeMouseConfig(false);
    const app = await bootTui();

    // Nothing reaches the tree while reporting is off, even if bytes
    // somehow arrive (a multiplexer that ate the disable, a paste).
    stdin.emit("data", sgrPress(5, 3));
    expect(app.seen).toHaveLength(0);

    app.setMouseEnabled(true);
    expect(trackingCalls.enabled).toBe(1);

    stdin.emit("data", sgrPress(5, 3));
    expect(app.seen).toHaveLength(1);
    expect(app.seen[0]).toMatchObject({ kind: "press", button: "left", x: 4, y: 2 });
    // The source the tree subscribed to at mount is the one receiving
    // them — that is the whole point.
    expect(app.mouse).toBeDefined();
    await app.stop();
  });

  it("stops delivering clicks after /mouse off", async () => {
    writeMouseConfig(true);
    const app = await bootTui();
    expect(trackingCalls.enabled).toBe(1);

    stdin.emit("data", sgrPress(9, 4));
    expect(app.seen).toHaveLength(1);

    app.setMouseEnabled(false);
    expect(trackingCalls.disabled).toBe(1);

    stdin.emit("data", sgrPress(9, 4));
    expect(app.seen).toHaveLength(1);
    await app.stop();
  });

  it("survives a full off → on cycle", async () => {
    writeMouseConfig(true);
    const app = await bootTui();
    app.setMouseEnabled(false);
    app.setMouseEnabled(true);
    stdin.emit("data", sgrPress(2, 2));
    expect(app.seen).toHaveLength(1);
    expect(getConfig().tui.mouse).toBe(true);
    await app.stop();
  });

  it("--no-mouse still wires the source so /mouse on can turn it on", async () => {
    writeMouseConfig(true);
    const app = await bootTui(["--no-mouse"]);
    expect(app.mouse).toBeDefined();
    expect(trackingCalls.enabled).toBe(0);

    app.setMouseEnabled(true);
    stdin.emit("data", sgrPress(7, 1));
    expect(app.seen).toHaveLength(1);
    await app.stop();
  });

  it("auto-disables mouse support when reports leak through as text", async () => {
    writeMouseConfig(true);
    const app = await bootTui();
    expect(trackingCalls.enabled).toBe(1);

    // Two ESC-less report bodies in one read: the shape of a terminal
    // (or ssh hop) answering the tracking request with an encoding the
    // decoder cannot consume.
    stdin.emit("data", Buffer.from("[<0;3;4M[<0;3;5M"));

    expect(trackingCalls.disabled).toBe(1);
    const notice = app.actions.find(
      (action) => action.type === "system_message",
    );
    expect(notice).toBeDefined();
    if (notice?.type === "system_message") {
      expect(notice.variant).toBe("warn");
      expect(notice.text).toContain("/mouse");
      expect(notice.text).toContain("--no-mouse");
    }
    // Session-only: the persisted preference is untouched.
    expect(getConfig().tui.mouse).toBe(true);

    // Reporting is off, so a straggler event is dropped like after
    // `/mouse off`.
    stdin.emit("data", sgrPress(2, 2));
    expect(app.seen).toHaveLength(0);
    await app.stop();
  });

  it("a shift-modified press opens the selection window instead of clicking", async () => {
    writeMouseConfig(true);
    const app = await bootTui();

    stdin.emit("data", sgrShiftPress(5, 3));
    // The gesture is consumed, never hit-tested; the operator is told
    // in chat what just happened.
    expect(app.seen).toHaveLength(0);
    expect(app.messages.some((m) => m.includes("drag to select"))).toBe(true);

    // A report already in flight when the suspend landed decodes here
    // anyway — swallowed, not clicked.
    stdin.emit("data", sgrPress(5, 3));
    expect(app.seen).toHaveLength(0);
    await app.stop();
  });

  it("a second signal restores the terminal and exits instead of hanging", async () => {
    writeMouseConfig(true);
    const before = process.listeners("SIGINT");
    const app = await bootTui();
    const added = process
      .listeners("SIGINT")
      .filter((listener) => !before.includes(listener));
    expect(added).toHaveLength(1);
    const onSignal = added[0] as () => void;

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    try {
      orchestratorCalls.quits = 0;
      onSignal();
      expect(orchestratorCalls.quits).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();

      onSignal();
      expect(orchestratorCalls.quits).toBe(1);
      expect(exitSpy).toHaveBeenCalledWith(130);
    } finally {
      exitSpy.mockRestore();
    }
    await app.stop();
  });

  it("delivers clicks again once the selection window expires", async () => {
    // `shouldAdvanceTime` keeps the boot's real 10ms poll loop alive
    // while the 10s selection window is jumped over synthetically.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    writeMouseConfig(true);
    const app = await bootTui();

    stdin.emit("data", sgrShiftPress(5, 3));
    expect(app.seen).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(DEFAULT_SELECTION_WINDOW_MS);
    expect(trackingCalls.resumed).toBe(1);
    expect(app.messages.some((m) => m.includes("mouse back on"))).toBe(true);

    stdin.emit("data", sgrPress(5, 3));
    expect(app.seen).toHaveLength(1);
    await app.stop();
  });

  it("keeps /mouse off during the selection window off for good", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    writeMouseConfig(true);
    const app = await bootTui();

    stdin.emit("data", sgrShiftPress(5, 3));
    app.setMouseEnabled(false);
    expect(trackingCalls.disabled).toBe(1);

    // The pending auto-resume must find nothing to resume: the operator
    // asked for reporting to stay gone.
    await vi.advanceTimersByTimeAsync(DEFAULT_SELECTION_WINDOW_MS);
    expect(trackingCalls.resumed).toBe(0);
    expect(trackingCalls.enabled).toBe(1);

    stdin.emit("data", sgrPress(5, 3));
    expect(app.seen).toHaveLength(0);
    await app.stop();
  });

  it("an alt-modified press opens the selection window instead of clicking", async () => {
    writeMouseConfig(true);
    const app = await bootTui();

    stdin.emit("data", sgrAltPress(5, 3));
    expect(app.seen).toHaveLength(0);
    expect(app.messages.some((m) => m.includes("drag to select"))).toBe(true);
    await app.stop();
  });

  it("a drag intent suspends, says to drag again, and auto-resumes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    writeMouseConfig(true);
    const app = await bootTui();

    // The unclaimed drag was detected in the tree; the wiring under
    // test is what happens next.
    app.selectionDragIntent();
    expect(
      app.messages.some((m) => m.includes("drag again to select")),
    ).toBe(true);

    // A report already in flight when the suspend landed is swallowed
    // — it also never reaches the tree, so the drag-intent tracker
    // cannot re-fire off the stale remainder of the gesture.
    stdin.emit("data", sgrPress(5, 3));
    expect(app.seen).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(DEFAULT_SELECTION_WINDOW_MS);
    expect(trackingCalls.resumed).toBe(1);
    expect(app.messages.some((m) => m.includes("mouse back on"))).toBe(true);

    stdin.emit("data", sgrPress(5, 3));
    expect(app.seen).toHaveLength(1);
    await app.stop();
  });
});
