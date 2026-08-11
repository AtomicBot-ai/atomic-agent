import type { Key } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import { fetchOpenAiCompatModels } from "../../llm/provider/openai/fetch-openai-compat-models.js";
import { reduceTuiState } from "../agent-event-reducer.js";
import { handleLlmPanelKey } from "../llm-panel/llm-panel-key-bindings.js";
import { selectCloudModelSection } from "../llm-panel/llm-panel-row-builders.js";
import { selectLlmPanelRows } from "../llm-panel/llm-panel-selectors.js";
import { makeTuiEventBus } from "../make-event-bus.js";
import { runSlashCommand } from "../submit-handler.js";
import { fakeSession } from "../test-fixtures.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { ProvidersOrchestrator } from "./providers-orchestrator.js";

/**
 * Integration tests for the LIVE inline-model-list chain:
 *
 *   keypress / slash command -> keymap handler or submit pipeline
 *   -> `onProvidersInlineModelsEnsureRequested` callback
 *   -> `ProvidersOrchestrator.ensureInlineModels` -> event bus
 *   -> real reducer -> inline section state -> row builder.
 *
 * The TUI has two channels: `dispatch` feeds the React reducer only, and
 * the event bus (which the orchestrator subscribes to and emits on) is
 * bridged into the reducer one way via `bus.subscribe(dispatch)`. These
 * tests wire the same pieces `tui-command.ts` wires and only ever press
 * keys / run slash commands, then assert on the resulting reducer state
 * — the discipline that caught the dead-reducer-action bug (e5ef04a).
 */

vi.mock("../../config/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../config/index.js")>();
  return {
    ...original,
    getConfig: () => currentConfig,
  };
});

// Provider switching persists the choice; tests must not write the real
// user config, so the persistence layer mutates the mocked config only.
vi.mock("../persist-llm-provider.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../persist-llm-provider.js")>();
  return {
    ...original,
    setActiveTextProviderInConfig: (id: string) => {
      currentConfig = {
        ...currentConfig,
        llm: { ...currentConfig.llm!, activeTextProvider: id },
      } as AtomicAgentConfig;
    },
  };
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

function configWithTwoProviders(
  nousBaseUrl: string,
  xaiBaseUrl: string,
): AtomicAgentConfig {
  return {
    llm: {
      activeTextProvider: "nous",
      activeEmbeddingProvider: "local-llama-embed",
      toolTransport: "auto",
      providers: [
        {
          id: "nous",
          kind: "openai-compatible",
          baseUrl: nousBaseUrl,
          apiKey: "sk-nous-test",
          model: "nous/bytedance",
          defaultChatModel: "nous/bytedance",
        },
        {
          id: "xai",
          kind: "openai-compatible",
          baseUrl: xaiBaseUrl,
          apiKey: "sk-xai-test",
          model: "grok-4",
          defaultChatModel: "grok-4",
        },
      ],
    },
  } as AtomicAgentConfig;
}

function emptyKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  };
}

/**
 * Assemble the production wiring in miniature: a real bus, a real
 * orchestrator subscribed to it, the real reducer as the only state
 * writer, and callbacks bound the same way `tui-command.ts` binds them.
 */
function makeHarness() {
  const bus = makeTuiEventBus();
  const runtime = {
    providerRegistry: {
      setActive: vi.fn(async () => {}),
      listIds: () => [],
    },
    reloadLlmProvider: vi.fn(async () => {}),
    reloadLlmProviders: vi.fn(async () => {}),
  } as unknown as AgentRuntime;
  const orchestrator = new ProvidersOrchestrator(runtime, bus);
  const store = { state: createInitialTuiState(fakeSession()) };
  const applyToReducer = (action: unknown) => {
    store.state = reduceTuiState(store.state, action as never);
  };
  // One-way bridge, exactly like `useEffect(() => bus.subscribe(dispatch))`.
  bus.subscribe(applyToReducer);
  const onProvidersSelectChatModel = vi.fn();
  const callbacks: TuiAppCallbacks = {
    onApprovalDecision: vi.fn(),
    onAbort: vi.fn(),
    onQuit: vi.fn(),
    onMessageSubmitted: vi.fn(),
    onProvidersSelectChatModel,
    // The wiring under test, verbatim from tui-command.ts.
    onProvidersChatModelPickerRequested: (providerId) =>
      void orchestrator.openChatModelPicker(providerId),
    onProvidersInlineModelsEnsureRequested: (providerId) =>
      void orchestrator.ensureInlineModels(providerId),
    onProvidersSetActiveText: (id) => void orchestrator.setActiveText(id),
  };
  const press = (input: string, key: Partial<Key> = {}) =>
    handleLlmPanelKey(input, emptyKey(key), {
      state: store.state,
      dispatch: applyToReducer,
      callbacks,
    });
  return { bus, orchestrator, store, callbacks, press, applyToReducer, onProvidersSelectChatModel };
}

function openLlmCloudTab(h: ReturnType<typeof makeHarness>, cursor: number): void {
  h.applyToReducer({ type: "ui_mode_set", mode: "debug" });
  h.applyToReducer({ type: "tab_changed", tab: "llm" });
  h.applyToReducer({ type: "llm_mode_set", mode: "cloud" });
  h.applyToReducer({ type: "llm_cursor_set", cursor });
}

function section(state: TuiState) {
  return selectCloudModelSection(state);
}

function modelRowIds(state: TuiState): readonly string[] {
  return selectLlmPanelRows(state, "cloud")
    .filter((row) => row.kind === "cloudChatModel")
    .map((row) => (row.kind === "cloudChatModel" ? row.modelId : ""));
}

function picker(state: TuiState) {
  return state.providersPanel.chatModelPicker;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inline list open flow: /model (cold /v1/models cache)", () => {
  it("focuses the filter, shows loading, loads the list, filters by typing, and selects", async () => {
    // Unique base URL per test: the /v1/models cache is module-global.
    currentConfig = configWithNous("https://cold-inline.nous.example");
    let releaseFetch: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await gate;
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: "qwen/qwen-3.5" },
            { id: "bytedance/seed-1.6" },
            { id: "meta/llama-4" },
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const h = makeHarness();
    h.orchestrator.refresh();

    runSlashCommand("/model", h.store.state, h.applyToReducer, h.callbacks);

    // Landed on the LLM tab, Cloud pane, filter focused, section loading
    // while /v1/models is in flight.
    expect(h.store.state.uiMode).toBe("debug");
    expect(h.store.state.activeTab).toBe("llm");
    expect(h.store.state.llmPanel.mode).toBe("cloud");
    expect(h.store.state.llmPanel.cloudModelFilterFocused).toBe(true);
    expect(section(h.store.state)).toMatchObject({ status: "loading" });
    // The loading fallback keeps the current model selectable.
    expect(modelRowIds(h.store.state)).toEqual(["nous/bytedance"]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://cold-inline.nous.example/v1/models",
    );
    // The provider's key must ride along on the fetch.
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer sk-nous-test" },
    });

    releaseFetch();
    await flush();
    expect(section(h.store.state)).toMatchObject({ status: "ready" });
    expect(modelRowIds(h.store.state)).toEqual([
      "nous/bytedance",
      "bytedance/seed-1.6",
      "meta/llama-4",
      "qwen/qwen-3.5",
    ]);

    // Typing filters the list in place through the panel key handler.
    for (const ch of "qwen") h.press(ch);
    expect(h.store.state.llmPanel.cloudModelFilter).toBe("qwen");
    expect(modelRowIds(h.store.state)).toEqual(["qwen/qwen-3.5"]);
    // The cursor snapped to the top of the filtered result set.
    expect(h.store.state.llmPanel.cloudCursor).toBe(
      section(h.store.state).sectionStart,
    );

    // Enter selects the filtered model through the existing mechanism.
    h.press("", { return: true });
    expect(h.onProvidersSelectChatModel).toHaveBeenCalledWith(
      "nous",
      "qwen/qwen-3.5",
    );
    expect(h.store.state.llmPanel.cloudModelFilterFocused).toBe(false);
  });

  it("shows the fetch error inline with a one-line current-model fallback", async () => {
    currentConfig = configWithNous("https://down-inline.nous.example");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND down-inline.nous.example");
      }),
    );

    const h = makeHarness();
    h.orchestrator.refresh();

    runSlashCommand("/model", h.store.state, h.applyToReducer, h.callbacks);
    await flush();

    expect(section(h.store.state)).toMatchObject({
      status: "error",
      error: expect.stringContaining("ENOTFOUND"),
    });
    // Fallback: the current model stays as the single selectable row.
    expect(modelRowIds(h.store.state)).toEqual(["nous/bytedance"]);
  });
});

describe("inline list reopen cycle: /model, Esc, /model again (live repro)", () => {
  it("keeps working on every invocation, not just the first", async () => {
    currentConfig = configWithNous("https://reopen-inline.nous.example");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ id: "alpha" }, { id: "beta" }] }),
      })),
    );

    const h = makeHarness();
    h.orchestrator.refresh();

    runSlashCommand("/model", h.store.state, h.applyToReducer, h.callbacks);
    await flush();
    expect(h.store.state.llmPanel.cloudModelFilterFocused).toBe(true);
    expect(section(h.store.state)).toMatchObject({ status: "ready" });

    // Esc leaves filter mode through the real key route; typed text stays.
    for (const ch of "al") h.press(ch);
    h.press("", { escape: true });
    expect(h.store.state.llmPanel.cloudModelFilterFocused).toBe(false);
    expect(h.store.state.llmPanel.cloudModelFilter).toBe("al");

    runSlashCommand("/model", h.store.state, h.applyToReducer, h.callbacks);
    await flush();
    expect(h.store.state.llmPanel.cloudModelFilterFocused).toBe(true);
    expect(section(h.store.state)).toMatchObject({ status: "ready" });
    expect(modelRowIds(h.store.state)).toEqual(["alpha"]);
  });
});

describe("f key: focus the inline filter from the panel", () => {
  it("focuses the filter row and drops the cursor into the model section", async () => {
    const baseUrl = "https://fkey.nous.example";
    currentConfig = configWithNous(baseUrl);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ id: "alpha" }, { id: "beta" }] }),
      })),
    );
    await fetchOpenAiCompatModels(baseUrl, "sk-nous-test");

    const h = makeHarness();
    h.orchestrator.refresh();
    openLlmCloudTab(h, 0); // cursor on the provider row

    expect(h.press("f")).toBe(true);
    expect(h.store.state.llmPanel.cloudModelFilterFocused).toBe(true);
    // Cursor moved into the model section (first model row).
    expect(h.store.state.llmPanel.cloudCursor).toBe(
      section(h.store.state).sectionStart,
    );

    // Arrow keys keep walking the filtered list while typing.
    h.press("", { downArrow: true });
    expect(h.store.state.llmPanel.cloudCursor).toBe(
      section(h.store.state).sectionStart + 1,
    );

    // Backspace edits, Esc exits and the letters become hotkeys again.
    h.press("a");
    h.press("", { backspace: true });
    expect(h.store.state.llmPanel.cloudModelFilter).toBe("");
    h.press("", { escape: true });
    expect(h.store.state.llmPanel.cloudModelFilterFocused).toBe(false);
  });
});

describe("provider switch repopulates the inline section", () => {
  it("Enter on another provider row fetches its catalog live and resets the filter", async () => {
    currentConfig = configWithTwoProviders(
      "https://switch-nous.example",
      "https://switch-xai.example",
    );
    let releaseXai: () => void = () => {};
    const xaiGate = new Promise<void>((resolve) => {
      releaseXai = resolve;
    });
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("switch-xai")) {
        await xaiGate;
        return {
          ok: true,
          json: async () => ({ data: [{ id: "grok-4" }, { id: "grok-5" }] }),
        };
      }
      return {
        ok: true,
        json: async () => ({ data: [{ id: "nous-a" }, { id: "nous-b" }] }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const h = makeHarness();
    h.orchestrator.refresh();
    void h.orchestrator.ensureInlineModels(null);
    await flush();
    expect(section(h.store.state).provider?.id).toBe("nous");
    expect(section(h.store.state).status).toBe("ready");

    // Leftover filter from browsing nous.
    h.applyToReducer({ type: "llm_cloud_filter_set", value: "nous" });

    // Enter on the second provider row (rows: [nous, xai, models...]).
    openLlmCloudTab(h, 1);
    h.press("", { return: true });
    await flush();

    // Switch landed: section now belongs to xai and is visibly loading
    // (its /v1/models is still in flight), the old filter is gone.
    expect(section(h.store.state).provider?.id).toBe("xai");
    expect(section(h.store.state).status).toBe("loading");
    expect(h.store.state.llmPanel.cloudModelFilter).toBe("");

    releaseXai();
    await flush();
    expect(section(h.store.state).status).toBe("ready");
    expect(modelRowIds(h.store.state)).toEqual(["grok-4", "grok-5"]);
  });
});

describe("modal picker (still used outside the Cloud pane) reopens cleanly", () => {
  it("open -> Esc -> open again through the real modal key route", async () => {
    const baseUrl = "https://modal-cycle.nous.example";
    currentConfig = configWithNous(baseUrl);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ id: "alpha" }, { id: "beta" }] }),
      })),
    );

    const h = makeHarness();
    h.orchestrator.refresh();
    openLlmCloudTab(h, 0);

    h.callbacks.onProvidersChatModelPickerRequested?.("nous");
    await flush();
    expect(picker(h.store.state)).toMatchObject({ status: "ready" });

    h.press("", { escape: true });
    expect(picker(h.store.state)).toBeNull();

    h.callbacks.onProvidersChatModelPickerRequested?.("nous");
    await flush();
    expect(picker(h.store.state)).toMatchObject({
      status: "ready",
      models: ["alpha", "beta"],
    });
  });
});

describe("inline list flow: bare /model end to end", () => {
  it("/model lands in the focused inline filter with the catalog loaded", async () => {
    currentConfig = configWithNous("https://slash-inline.nous.example");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ id: "delta" }, { id: "gamma" }] }),
      })),
    );

    const h = makeHarness();
    h.orchestrator.refresh();

    runSlashCommand("/model", h.store.state, h.applyToReducer, h.callbacks);
    await flush();

    expect(h.store.state.uiMode).toBe("debug");
    expect(h.store.state.activeTab).toBe("llm");
    expect(h.store.state.llmPanel.cloudModelFilterFocused).toBe(true);
    expect(section(h.store.state)).toMatchObject({ status: "ready" });
    expect(modelRowIds(h.store.state)).toEqual([
      "nous/bytedance",
      "delta",
      "gamma",
    ]);
  });
});
