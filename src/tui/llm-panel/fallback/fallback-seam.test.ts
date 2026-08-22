import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Key } from "ink";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "../../../config/index.js";
import { reduceTuiState } from "../../agent-event-reducer.js";
import { fakeSession } from "../../test-fixtures.js";
import type { TuiAction } from "../../tui-action.js";
import type { TuiAppCallbacks } from "../../tui-app.js";
import { createInitialTuiState, type TuiState } from "../../tui-state.js";
import { handleLlmPanelKey } from "../llm-panel-key-bindings.js";
import { FallbackOrchestrator } from "./fallback-orchestrator.js";

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";

/**
 * The UI→orchestrator seam, end to end: a KEYPRESS in the Fallback pane
 * must land in `FallbackOrchestrator` through the `onFallback*` callbacks
 * and come back as a config write plus a `fallback_refresh` that updates
 * the mirrored state. This is the exact seam that was broken before —
 * the key handler dispatched `*_requested` reducer actions, the reducer
 * no-opped them, and the orchestrator (listening on the bus, which
 * dispatch never reaches) heard nothing: every edit was a silent no-op.
 * The harness wires the three real layers the way `tui-command.ts` does:
 * bus→dispatch bridge, callbacks→orchestrator methods.
 */
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

function makeBus() {
  const listeners = new Set<(action: TuiAction) => void>();
  const emitted: TuiAction[] = [];
  return {
    emitted,
    subscribe(listener: (action: TuiAction) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(action: TuiAction) {
      emitted.push(action);
      for (const listener of [...listeners]) listener(action);
    },
  };
}

function seedConfig(stateDir: string): void {
  const config = {
    llm: {
      activeTextProvider: "cloud-a",
      activeEmbeddingProvider: "cloud-a",
      toolTransport: "auto",
      providers: [
        { id: "cloud-a", kind: "openrouter", defaultChatModel: "vendor/a" },
        { id: "cloud-b", kind: "aimlapi", defaultChatModel: "vendor/b" },
        { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
      ],
      fallback: { chain: ["cloud-a", "cloud-b"], appendLocal: false },
    },
  };
  writeFileSync(join(stateDir, "config.json"), JSON.stringify(config), "utf8");
}

function readChain(stateDir: string): unknown {
  const onDisk = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"));
  return onDisk.llm?.fallback?.chain;
}

interface Harness {
  press: (input: string, key?: Key) => boolean;
  state: () => TuiState;
  emitted: TuiAction[];
}

/** The real app wiring in miniature: bus→dispatch, callbacks→methods. */
function mountSeam(): Harness {
  const bus = makeBus();
  const orchestrator = new FallbackOrchestrator(bus);
  let state: TuiState = createInitialTuiState(fakeSession());
  const dispatch = (action: TuiAction): void => {
    state = reduceTuiState(state, action);
  };
  bus.subscribe(dispatch);
  const callbacks: TuiAppCallbacks = {
    onFallbackMoveRequested: (providerId, delta) =>
      orchestrator.move(providerId, delta),
    onFallbackAddRequested: (providerId) => orchestrator.add(providerId),
    onFallbackRemoveRequested: (providerId) => orchestrator.remove(providerId),
    onFallbackAppendLocalToggleRequested: () =>
      orchestrator.toggleAppendLocal(),
  };
  // Mirror config into the pane (what LLM-tab entry does), then focus it.
  orchestrator.refresh();
  dispatch({ type: "ui_mode_set", mode: "debug" });
  dispatch({ type: "tab_changed", tab: "llm" });
  dispatch({ type: "llm_mode_set", mode: "fallback" });
  return {
    press: (input, key = emptyKey()) =>
      handleLlmPanelKey(input, key, { state, dispatch, callbacks }),
    state: () => state,
    emitted: bus.emitted,
  };
}

describe("fallback pane UI→orchestrator seam", () => {
  let stateDir: string;
  let original: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "fallback-seam-"));
    mkdirSync(stateDir, { recursive: true });
    original = process.env[STATE_DIR_ENV];
    process.env[STATE_DIR_ENV] = stateDir;
    resetConfigCache();
    seedConfig(stateDir);
  });

  afterEach(() => {
    if (original === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = original;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("a < keypress persists the reorder and re-mirrors the pane", () => {
    const app = mountSeam();
    // Cursor to row 1 (cloud-b), then move it up in priority. (Down
    // would be clamped — cloud-b is already the last declared link.)
    app.press("j");
    expect(app.press("<")).toBe(true);
    expect(readChain(stateDir)).toEqual(["cloud-b", "cloud-a"]);
    // The write came back as a refresh: the pane mirror moved too, with
    // the loader re-hoisting the active provider (cloud-a) to the head.
    const links = app.state().fallbackPanel.links.map((l) => l.providerId);
    expect(links[0]).toBe("cloud-a");
    expect(app.emitted.some((a) => a.type === "fallback_refresh")).toBe(true);
  });

  it("Enter in the add picker persists the new link", () => {
    const app = mountSeam();
    // local-llama is the one addable provider; a opens, Enter adds.
    app.press("a");
    expect(app.state().fallbackPanel.addPicker).toEqual({ cursor: 0 });
    app.press("", emptyKey({ return: true }));
    expect(readChain(stateDir)).toEqual(["cloud-a", "cloud-b", "local-llama"]);
    expect(app.state().fallbackPanel.addPicker).toBeNull();
    // The refresh emptied the addable list; the mirror shows all three.
    expect(app.state().fallbackPanel.links).toHaveLength(3);
  });

  it("d persists the removal and the cursor survives the shrink", () => {
    const app = mountSeam();
    app.press("j"); // row 1 = cloud-b
    app.press("d");
    expect(readChain(stateDir)).toEqual(["cloud-a"]);
    // Rows shrank (1 link + add row); the refresh re-clamped the cursor.
    expect(app.state().llmPanel.fallbackCursor).toBeLessThanOrEqual(1);
  });

  it("l persists the appendLocal flip", () => {
    const app = mountSeam();
    app.press("l");
    const onDisk = JSON.parse(
      readFileSync(join(stateDir, "config.json"), "utf8"),
    );
    expect(onDisk.llm.fallback.appendLocal).toBe(true);
    expect(app.state().fallbackPanel.appendLocal).toBe(true);
  });
});
