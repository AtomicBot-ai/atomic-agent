import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "../tui-app.js";
import { fakeSession } from "../test-fixtures.js";
import { makeMouseSource, type MouseSourceEmitter } from "../mouse/mouse-source.js";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { ProvidersOrchestrator } from "./providers-orchestrator.js";

/**
 * The `/model` list under the mouse, driven through the real registry.
 *
 * `/model` is not a floating window but it *behaves* as a modal: the
 * focused `filter:` row owns every printable key, so `isPanelModalOpen`
 * reports true and `TuiApp` raises the mouse registry's floor to
 * `MOUSE_LAYER_MODAL`. Rows registered at the panel layer are dropped
 * without a trace at exactly that moment, which is why this needs an
 * app-level test: the component renders its `MouseTarget` either way,
 * and only the live registry can tell you the click went nowhere.
 */

vi.mock("../../config/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../config/index.js")>();
  return { ...original, getConfig: () => currentConfig };
});

let currentConfig: AtomicAgentConfig;

function configWithNous(baseUrl: string): AtomicAgentConfig {
  return {
    llm: {
      activeTextProvider: "nous",
      activeEmbeddingProvider: "local-llama-embed",
      toolTransport: "auto",
      providers: [
        {
          id: "nous",
          kind: "openai-compatible",
          baseUrl,
          apiKey: "sk-nous-test",
          model: "nous/bytedance",
          defaultChatModel: "nous/bytedance",
        },
      ],
    },
  } as AtomicAgentConfig;
}

const SESSION = fakeSession({ workingDir: "/tmp/model-click" });

function strip(value: string): string {
  return value
    .replace(/\[[0-9;]*m/g, "")
    .replace(/\]8;;[^]*/g, "");
}

/** Cell of `needle` in the frame — the cell a terminal would report. */
function locate(frame: string, needle: string): { x: number; y: number } {
  for (const [y, line] of frame.split("\n").entries()) {
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
 * Ink commits on its own throttle and React registers the click targets
 * in an effect after that commit, so a freshly painted row is not
 * clickable for a frame or two. Re-send the click until it lands, the
 * way an operator would — see `mouse-app.test.tsx` for the same pattern.
 */
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

function mountApp() {
  const bus = makeTuiEventBus();
  const mouse = makeMouseSource();
  const orchestrator = new ProvidersOrchestrator({} as AgentRuntime, bus);
  const onProvidersSelectChatModel = vi.fn();
  const callbacks: TuiAppCallbacks = {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {},
    onMessageSubmitted: () => {},
    onProvidersTabRefresh: () => {
      orchestrator.refresh();
      void orchestrator.ensureInlineModels(null);
    },
    onProvidersSelectChatModel,
    onProvidersInlineModelsEnsureRequested: (providerId) =>
      void orchestrator.ensureInlineModels(providerId),
  };
  const { lastFrame, stdin, unmount } = render(
    <TuiApp session={SESSION} bus={bus} callbacks={callbacks} mouse={mouse} />,
  );
  return {
    frame: () => strip(lastFrame() ?? ""),
    bus,
    mouse,
    stdin,
    unmount,
    onProvidersSelectChatModel,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/model list clicks", () => {
  it("selects on the first click and switches the model on the second", async () => {
    currentConfig = configWithNous("https://click.nous.example");
    const models = Array.from({ length: 6 }, (_, i) => `vendor/model-${i}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: models.map((id) => ({ id })) }),
      })),
    );

    const app = mountApp();
    await waitUntil(() => app.frame().includes("llama.cpp"), "the Run screen");
    app.stdin.write("/model");
    await delay(50);
    app.stdin.write("\r");
    await waitUntil(
      () => app.frame().includes("vendor/model-1"),
      "the inline model list",
    );
    // Cursor starts on the current model, which the section lists first.
    expect(app.frame()).toContain("(1/7)");

    // Two-step, not one: Enter on a model row repoints the chat route at
    // it (and on the Local pane the same row starts a multi-GB
    // download), so a stray click must not be able to do that. The first
    // click only moves the cursor.
    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "vendor/model-1"),
      () => app.frame().includes("(3/7)"),
      "first click on the vendor/model-1 row",
    );
    expect(app.onProvidersSelectChatModel).not.toHaveBeenCalled();

    // Second click on the row that now holds the cursor commits it,
    // through the same handler Enter uses.
    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "vendor/model-1"),
      () => app.onProvidersSelectChatModel.mock.calls.length > 0,
      "second click on the vendor/model-1 row",
    );
    expect(app.onProvidersSelectChatModel).toHaveBeenCalledWith(
      "nous",
      "vendor/model-1",
    );

    app.unmount();
  });

  it("drives the reopenable picker modal from the mouse too", async () => {
    // The modal picker is no longer what `/model` opens, but it is still
    // the surface for flows outside the Cloud pane, and a modal that
    // ignores the mouse is exactly the gap this sweep is closing.
    currentConfig = configWithNous("https://modal.nous.example");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));

    const app = mountApp();
    await waitUntil(() => app.frame().includes("llama.cpp"), "the Run screen");
    app.bus.emit({ type: "ui_mode_set", mode: "debug" });
    app.bus.emit({ type: "tab_changed", tab: "llm" });
    app.bus.emit({
      type: "providers_chat_model_picker_opened",
      providerId: "nous",
      currentModelId: "nous/bytedance",
      generation: 1,
    });
    app.bus.emit({
      type: "providers_chat_model_picker_loaded",
      generation: 1,
      models: ["alpha/one", "beta/two", "gamma/three"],
    });
    await waitUntil(
      () => app.frame().includes("beta/two"),
      "the modal picker",
    );

    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "beta/two"),
      () => app.frame().includes("(2/3)"),
      "first click on the beta/two row",
    );
    expect(app.onProvidersSelectChatModel).not.toHaveBeenCalled();

    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "beta/two"),
      () => app.onProvidersSelectChatModel.mock.calls.length > 0,
      "second click on the beta/two row",
    );
    expect(app.onProvidersSelectChatModel).toHaveBeenCalledWith(
      "nous",
      "beta/two",
    );

    app.unmount();
  });

  it("drives the provider wizard's pick list from the mouse", async () => {
    currentConfig = configWithNous("https://wizard.nous.example");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));

    const app = mountApp();
    await waitUntil(() => app.frame().includes("llama.cpp"), "the Run screen");
    app.bus.emit({ type: "ui_mode_set", mode: "debug" });
    app.bus.emit({ type: "tab_changed", tab: "llm" });
    await waitUntil(() => app.frame().includes("▸ LLM"), "the LLM tab");
    // `n` is the panel's own "add provider" hotkey, so the wizard opens
    // the way an operator opens it.
    app.stdin.write("n");
    await waitUntil(
      () => app.frame().includes("LLM provider"),
      "the add-provider wizard",
    );
    expect(app.frame()).toContain("(1/");

    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "OpenRouter (cloud"),
      () => app.frame().includes("(3/"),
      "first click on the OpenRouter kind row",
    );
    // Still on the kind list: one click never advances a wizard step.
    expect(app.frame()).toContain("LLM provider");

    await clickUntil(
      app.mouse,
      () => locate(app.frame(), "OpenRouter (cloud"),
      () => !app.frame().includes("LLM provider"),
      "second click on the OpenRouter kind row",
    );
    expect(app.frame()).not.toContain("LLM provider");

    app.unmount();
  });
});
