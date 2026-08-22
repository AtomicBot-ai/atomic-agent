import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { makeMouseSource, type MouseSourceEmitter } from "../mouse/mouse-source.js";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "../tui-app.js";
import type { TuiSessionInfo } from "../tui-state.js";
import { providerRow } from "./composer-switch-fixtures.js";

const SESSION: TuiSessionInfo = {
  sessionId: null,
  workingDir: "/tmp/composer-switch",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

/** Ctrl+R, as the terminal sends it. */
const CTRL_R = String.fromCharCode(18);
const ESC = String.fromCharCode(27);

function strip(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function locate(frame: string, needle: string): { x: number; y: number } {
  const lines = frame.split("\n");
  for (const [y, line] of lines.entries()) {
    const x = line.indexOf(needle);
    if (x !== -1) return { x, y };
  }
  throw new Error(`"${needle}" is not on screen:\n${frame}`);
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

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ink commits on its own throttle and registers click targets in the
 * effect after that commit, so nothing here waits a fixed number of
 * milliseconds: `waitUntil` polls the frame and `clickUntil` re-sends
 * the click, the way an operator clicks again when the first one lands
 * mid-repaint.
 */
async function waitUntil(
  condition: () => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function clickUntil(
  mouse: MouseSourceEmitter,
  point: () => { x: number; y: number },
  settled: () => boolean,
  what: string,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const { x, y } = point();
    mouse.emit(click(x, y));
    await delay(50);
    if (settled()) return;
  }
  throw new Error(`click never took effect: ${what}`);
}

function mountApp() {
  const bus = makeTuiEventBus();
  const mouse = makeMouseSource();
  const activated: string[] = [];
  const { lastFrame, stdin, unmount } = render(
    <TuiApp
      session={SESSION}
      bus={bus}
      callbacks={
        {
          onApprovalDecision: () => {},
          onAbort: () => {},
          onQuit: () => {},
          onMessageSubmitted: () => {},
          onProvidersSetActiveText: (id: string) => activated.push(id),
        } as TuiAppCallbacks
      }
      mouse={mouse}
    />,
  );
  bus.emit({
    type: "providers_refresh",
    rows: [
      providerRow({ isActiveText: true }),
      providerRow({
        id: "local-llama",
        kind: "llama-server",
        hasApiKey: false,
        chatModel: null,
        chatModelOptions: [],
      }),
    ],
  });
  return {
    frame: () => strip(lastFrame() ?? ""),
    mouse,
    stdin,
    activated,
    unmount,
  };
}

describe("the composer's route controls inside the app", () => {
  it("states the route as backend, provider, model", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("openrouter"), "the route line");
    const line =
      app
        .frame()
        .split("\n")
        .find((row) => row.includes("openrouter")) ?? "";
    expect(line.indexOf("cloud")).toBeGreaterThanOrEqual(0);
    expect(line.indexOf("cloud")).toBeLessThan(line.indexOf("openrouter"));
    expect(line.indexOf("openrouter")).toBeLessThan(
      line.indexOf("qwen/qwen3.7-max"),
    );
    app.unmount();
  });

  it("opens the backend switch when the backend word is clicked", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("openrouter"), "the route line");
    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "cloud"),
      () => app.frame().includes("WHERE IT RUNS"),
      "click on the backend control",
    );
    expect(app.frame()).toContain("custom");
    app.unmount();
  });

  it("routes a clicked backend row through the orchestrator callback", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("openrouter"), "the route line");
    // Opened with the key rather than a click: the row's coordinates
    // have to be read from a popup that is not about to move, and the
    // click under test is the one on the row.
    app.stdin.write(CTRL_R);
    await waitUntil(
      () => app.frame().includes("WHERE IT RUNS"),
      "the backend switch",
    );
    // The popup's row targets register in the effect after its first
    // commit, and until they do the backdrop is the only thing under the
    // cursor — clicking into that window would dismiss the panel.
    await delay(250);
    const target = locate(app.frame(), "local");
    await clickUntil(
      app.mouse,
      () => target,
      () => app.activated.length > 0,
      "click on the local row",
    );
    expect(app.activated).toEqual(["local-llama"]);
    app.unmount();
  });

  it("opens the provider switch when the provider is clicked", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("openrouter"), "the route line");
    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "openrouter"),
      () => app.frame().includes("PROVIDER"),
      "click on the provider control",
    );
    expect(app.frame()).toContain("Add a new provider");
    app.unmount();
  });

  it("opens and closes the strip from the keyboard", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("openrouter"), "the route line");
    app.stdin.write(CTRL_R);
    await waitUntil(
      () => app.frame().includes("WHERE IT RUNS"),
      "the backend switch",
    );
    app.stdin.write(ESC);
    await waitUntil(
      () => !app.frame().includes("WHERE IT RUNS"),
      "the switch to close",
    );
    // The composer is still the composer: Esc closed an overlay, it did
    // not take the operator off the Run screen.
    expect(app.frame()).toContain("openrouter");
    app.unmount();
  });

  it("keeps the composer typable once the strip is closed", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("openrouter"), "the route line");
    app.stdin.write(CTRL_R);
    await waitUntil(
      () => app.frame().includes("WHERE IT RUNS"),
      "the backend switch",
    );
    // While the switch owns the keyboard, letters type into its
    // filter, not into the composer…
    app.stdin.write("zzz");
    await waitUntil(
      () => app.frame().includes("filter: zzz"),
      "the typed filter",
    );
    // …Esc pays the filter before it pays the popup…
    app.stdin.write(ESC);
    await waitUntil(
      () => app.frame().includes("filter: type to filter"),
      "the filter to clear",
    );
    app.stdin.write(ESC);
    await waitUntil(
      () => !app.frame().includes("WHERE IT RUNS"),
      "the switch to close",
    );
    // …and the composer types normally after it lets go, without the
    // filter text having leaked into its buffer.
    app.stdin.write("hello");
    await waitUntil(() => app.frame().includes("hello"), "the typed buffer");
    expect(app.frame()).not.toContain("zzz");
    app.unmount();
  });
});
