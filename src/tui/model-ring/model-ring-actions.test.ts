import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Key } from "ink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleAppKey, type AppKeyContext } from "../app-key-bindings.js";
import { dispatchSlashCommand } from "../commands/slash-command-handler.js";
import { cloudState, fusionState, localState, providerRow } from "../composer-switch/composer-switch-fixtures.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import type { TuiState } from "../tui-state.js";
import { reduceUiAction } from "../reduce-ui-actions.js";
import { selectMetaBarFit } from "../select-chrome-rows.js";
import { cycleModelRing, runModelRingCommand } from "./model-ring-actions.js";
import { modelRingKeyDirection } from "./model-ring-keys.js";
import { describeModelRing, selectModelRingReadout } from "./model-ring.js";
import { readModelRing, startupModelRing, writeModelRing } from "./model-ring-store.js";

const e = (provider: string, model: string) => ({ provider, model });

function callbacks() {
  return {
    onProvidersSelectChatModel: vi.fn(),
    onProvidersSetActiveText: vi.fn(),
    onLocalModelsSetActiveRequested: vi.fn(),
    onLocalModelsDaemonStartRequested: vi.fn(),
    onLocalModelsChatStopForCloudRequested: vi.fn(),
  };
}
const asCallbacks = (c: ReturnType<typeof callbacks>) => c as unknown as TuiAppCallbacks;

/** A cloud route on openrouter, with openai keyed too and one local model on disk. */
function mixedState(): TuiState {
  const cloud = cloudState();
  const local = localState("managed");
  return {
    ...cloud,
    providersPanel: {
      ...cloud.providersPanel,
      rows: [...cloud.providersPanel.rows, providerRow({ id: "openai", kind: "openai", chatModel: "gpt-5" })],
    },
    localModelsPanel: { ...local.localModelsPanel, daemon: { ...local.localModelsPanel.daemon, running: false } },
  };
}

function notices(dispatch: ReturnType<typeof vi.fn>): string[] {
  return dispatch.mock.calls
    .map(([a]) => a as TuiAction)
    .filter((a): a is Extract<TuiAction, { type: "composer_notice" }> => a.type === "composer_notice")
    .map((a) => a.text ?? "");
}
function messages(dispatch: ReturnType<typeof vi.fn>): string[] {
  return dispatch.mock.calls
    .map(([a]) => a as TuiAction)
    .filter((a): a is Extract<TuiAction, { type: "system_message" }> => a.type === "system_message")
    .map((a) => a.text);
}

let stateDir = "";
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "atomic-model-ring-actions-")); });
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("/model favorite", () => {
  it("is routed to the ring command, and a bad one prints the usage", () => {
    expect(dispatchSlashCommand("/model favorite add openai/gpt-5").modelRingCommand).toEqual({ kind: "add", entry: e("openai", "gpt-5") });
    expect(dispatchSlashCommand("/models fav").modelRingCommand).toEqual({ kind: "list" });
    const bad = dispatchSlashCommand("/model favorite add nope");
    expect(bad.modelRingCommand).toBeUndefined();
    expect(bad.systemMessage).toMatch(/^usage: \/model favorite/);
  });

  it("add with no model puts the current one in; add again says so; remove takes it out", () => {
    const dispatch = vi.fn();
    runModelRingCommand({ kind: "add", entry: null }, cloudState(), dispatch, stateDir);
    expect(readModelRing(stateDir)).toEqual([e("openrouter", "qwen/qwen3.7-max")]);
    expect(messages(dispatch).at(-1)).toContain("Added openrouter/qwen/qwen3.7-max");
    runModelRingCommand({ kind: "add", entry: null }, cloudState(), dispatch, stateDir);
    expect(messages(dispatch).at(-1)).toContain("already a favorite");
    runModelRingCommand({ kind: "add", entry: e("local-llama", "qwen-3.5-4b") }, cloudState(), dispatch, stateDir);
    expect(readModelRing(stateDir)).toHaveLength(2);
    runModelRingCommand({ kind: "remove", entry: e("openrouter", "qwen/qwen3.7-max") }, cloudState(), dispatch, stateDir);
    expect(readModelRing(stateDir)).toEqual([e("local-llama", "qwen-3.5-4b")]);
    runModelRingCommand({ kind: "clear" }, cloudState(), dispatch, stateDir);
    expect(readModelRing(stateDir)).toEqual([]);
  });

  it("refuses to add the current model under Fusion, and writes nothing", () => {
    const dispatch = vi.fn();
    runModelRingCommand({ kind: "add", entry: null }, fusionState(), dispatch, stateDir);
    expect(messages(dispatch)[0]).toContain("cannot be a favorite");
    expect(readModelRing(stateDir)).toEqual([]);
  });
});

describe("ctrl+p", () => {
  it("walks the ring: cloud to cloud, to local, and back to the first", () => {
    writeModelRing(stateDir, [e("openrouter", "qwen/qwen3.7-max"), e("openai", "gpt-5"), e("local-llama", "qwen-3.5-4b")]);
    const cb = callbacks();
    const dispatch = vi.fn();
    // On openrouter now (the first favorite): the next is openai.
    cycleModelRing(mixedState(), dispatch, asCallbacks(cb), stateDir);
    expect(cb.onProvidersSelectChatModel).toHaveBeenLastCalledWith("openai", "gpt-5");
    expect(notices(dispatch).at(-1)).toBe("Model: openai/gpt-5 (2/3)");
    // On openai: the next is the local model, routed through its Local row.
    const onOpenAi = mixedState();
    const rows = onOpenAi.providersPanel.rows.map((r) => ({ ...r, isActiveText: r.id === "openai" }));
    cycleModelRing({ ...onOpenAi, providersPanel: { ...onOpenAi.providersPanel, rows } }, dispatch, asCallbacks(cb), stateDir);
    expect(cb.onProvidersSetActiveText).toHaveBeenCalledWith("local-llama");
    expect(notices(dispatch).at(-1)).toBe("Model: local-llama/qwen-3.5-4b (3/3)");
    // On the local model: back to the first.
    const local = localState("managed");
    const onLocal = { ...local, localModelsPanel: { ...local.localModelsPanel, activeModelId: "qwen-3.5-4b" as never } };
    const withCloud = { ...onLocal, providersPanel: { ...onLocal.providersPanel, rows: [...onLocal.providersPanel.rows, providerRow()] } };
    cycleModelRing(withCloud, dispatch, asCallbacks(cb), stateDir);
    expect(cb.onProvidersSelectChatModel).toHaveBeenLastCalledWith("openrouter", "qwen/qwen3.7-max");
    expect(notices(dispatch).at(-1)).toBe("Model: openrouter/qwen/qwen3.7-max (1/3)");
    // Leaving the running local daemon for a cloud model stops its chat side, as the Cloud pane does.
    expect(cb.onLocalModelsChatStopForCloudRequested).toHaveBeenCalledTimes(1);
  });

  it("says why instead of switching: no ring, Fusion, a running turn, no key, not downloaded", () => {
    const cb = callbacks();
    const dispatch = vi.fn();
    cycleModelRing(cloudState(), dispatch, asCallbacks(cb), stateDir);
    expect(notices(dispatch).at(-1)).toContain("No favorite models yet");
    writeModelRing(stateDir, [e("aimlapi", "m"), e("local-llama", "not-here")]);
    cycleModelRing(fusionState(), dispatch, asCallbacks(cb), stateDir);
    expect(notices(dispatch).at(-1)).toContain("Fusion");
    cycleModelRing({ ...cloudState(), status: "running" } as TuiState, dispatch, asCallbacks(cb), stateDir);
    expect(notices(dispatch).at(-1)).toBe("Switch models after this turn.");
    cycleModelRing(cloudState(), dispatch, asCallbacks(cb), stateDir);
    expect(notices(dispatch).at(-1)).toBe("aimlapi/m (1/2): that provider has no API key");
    const onAimlapi = cloudState();
    const rows = onAimlapi.providersPanel.rows.map((r) => (r.id === "aimlapi" ? { ...r, isActiveText: true, chatModel: "m" } : { ...r, isActiveText: false }));
    cycleModelRing({ ...onAimlapi, providersPanel: { ...onAimlapi.providersPanel, rows } }, dispatch, asCallbacks(cb), stateDir);
    expect(notices(dispatch).at(-1)).toBe("local-llama/not-here (2/2): not downloaded on this computer");
    expect(cb.onProvidersSelectChatModel).not.toHaveBeenCalled();
    expect(cb.onProvidersSetActiveText).not.toHaveBeenCalled();
  });

  it("the key reaches the switch on the prompt, and stands down under the slash palette", () => {
    const key = { ctrl: true, shift: false, meta: false } as Key;
    const cycle = vi.fn();
    const ctx = (state: TuiState) => ({
      state,
      dispatch: vi.fn(),
      callbacks: { onApprovalDecision: vi.fn(), onAbort: vi.fn(), onQuit: vi.fn() },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: false,
      activateComposerSwitch: vi.fn(),
      onModelRingCycle: cycle,
    }) as unknown as AppKeyContext;
    expect(handleAppKey("p", key, ctx(cloudState()))).toBe(true);
    expect(cycle).toHaveBeenCalledTimes(1);
    handleAppKey("p", key, ctx({ ...cloudState(), slashPaletteOpen: true }));
    expect(cycle).toHaveBeenCalledTimes(1);
  });
});

describe("ATO-2500: back key, --models, the bar readout", () => {
  it("alt+p and ctrl+shift+p walk back; ctrl+p forward; vim's Esc-p and other keys are not ring keys", () => {
    expect(modelRingKeyDirection("p", { ctrl: true, shift: false, meta: false })).toBe(1);
    expect(modelRingKeyDirection("P", { ctrl: true, shift: true, meta: false })).toBe(-1);
    expect(modelRingKeyDirection("p", { ctrl: false, shift: false, meta: true })).toBe(-1);
    expect(modelRingKeyDirection("p", { ctrl: false, shift: false, meta: true }, true)).toBeNull();
    expect(modelRingKeyDirection("p", { ctrl: false, shift: false, meta: false })).toBeNull();
    expect(modelRingKeyDirection("o", { ctrl: true, shift: false, meta: false })).toBeNull();
  });

  it("the listing says alt+p needs Option as Meta on a Mac, and a Mac's Option+P character stays text", () => {
    // Terminal.app and iTerm2 with default settings send "π" for Option+P,
    // no meta: the hint must not promise a back key there, and the
    // character must not be swallowed as one (it is typed).
    const ring = [{ provider: "openai", model: "gpt-5" }, { provider: "openrouter", model: "a/b" }];
    const listing = describeModelRing(ring, ring[0]!);
    expect(listing).toContain("alt+p (on a Mac: Option as Meta) to the previous one");
    expect(listing).not.toContain("any terminal");
    expect(modelRingKeyDirection("\u03c0", { ctrl: false, shift: false, meta: false })).toBeNull();
  });

  it("alt+p reaches the switch going backwards, from the global key handler", () => {
    const cycle = vi.fn();
    const ctx = {
      state: cloudState(),
      dispatch: vi.fn(),
      callbacks: { onApprovalDecision: vi.fn(), onAbort: vi.fn(), onQuit: vi.fn() },
      ctrlCArmed: false,
      setCtrlCArmed: vi.fn(),
      sidebarVisible: false,
      activateComposerSwitch: vi.fn(),
      onModelRingCycle: cycle,
    } as unknown as AppKeyContext;
    expect(handleAppKey("p", { ctrl: false, shift: false, meta: true } as Key, ctx)).toBe(true);
    expect(cycle).toHaveBeenLastCalledWith(-1);
    expect(handleAppKey("p", { ctrl: true, shift: false, meta: false } as Key, ctx)).toBe(true);
    expect(cycle).toHaveBeenLastCalledWith(1);
  });

  it("the previous favorite from the first one is the last one", () => {
    writeModelRing(stateDir, [e("openrouter", "qwen/qwen3.7-max"), e("openai", "gpt-5"), e("aimlapi", "m")]);
    const cb = callbacks();
    const dispatch = vi.fn();
    cycleModelRing(mixedState(), dispatch, asCallbacks(cb), stateDir, -1);
    expect(notices(dispatch).at(-1)).toBe("aimlapi/m (3/3): that provider has no API key");
    cycleModelRing(mixedState(), dispatch, asCallbacks(cb), stateDir, 1);
    expect(cb.onProvidersSelectChatModel).toHaveBeenLastCalledWith("openai", "gpt-5");
  });

  it("re-reads the shared file on every press, so a star set in the desktop is on the ring", () => {
    const dispatch = vi.fn();
    const cb = callbacks();
    writeModelRing(stateDir, [e("openrouter", "qwen/qwen3.7-max")]);
    cycleModelRing(mixedState(), dispatch, asCallbacks(cb), stateDir);
    // The desktop adds openai/gpt-5 to the same file.
    writeModelRing(stateDir, [e("openrouter", "qwen/qwen3.7-max"), e("openai", "gpt-5")]);
    cycleModelRing(mixedState(), dispatch, asCallbacks(cb), stateDir);
    expect(cb.onProvidersSelectChatModel).toHaveBeenLastCalledWith("openai", "gpt-5");
    const loaded = dispatch.mock.calls.map(([a]) => a as TuiAction).filter((a) => a.type === "model_ring_loaded");
    expect(loaded.at(-1)).toEqual({ type: "model_ring_loaded", ring: { entries: [e("openrouter", "qwen/qwen3.7-max"), e("openai", "gpt-5")], sessionOnly: false } });
  });

  it("a --models ring is walked instead of the file and changed for the session only", () => {
    writeModelRing(stateDir, [e("aimlapi", "m")]);
    const session = { ...mixedState(), modelRing: startupModelRing([e("openrouter", "qwen/qwen3.7-max"), e("openai", "gpt-5")], stateDir) };
    expect(session.modelRing).toEqual({ entries: [e("openrouter", "qwen/qwen3.7-max"), e("openai", "gpt-5")], sessionOnly: true });
    const cb = callbacks();
    const dispatch = vi.fn();
    cycleModelRing(session, dispatch, asCallbacks(cb), stateDir);
    expect(cb.onProvidersSelectChatModel).toHaveBeenLastCalledWith("openai", "gpt-5");
    runModelRingCommand({ kind: "remove", entry: e("openai", "gpt-5") }, session, dispatch, stateDir);
    expect(messages(dispatch).at(-1)).toContain("not saved");
    // The saved list is untouched.
    expect(readModelRing(stateDir)).toEqual([e("aimlapi", "m")]);
    expect(startupModelRing(null, stateDir)).toEqual({ entries: [e("aimlapi", "m")], sessionOnly: false });
  });

  it("the composer bar says fav n/m on a favorite and reserves its width", () => {
    const ring = { entries: [e("openai", "gpt-5"), e("openrouter", "qwen/qwen3.7-max")], sessionOnly: false };
    const on = reduceUiAction(cloudState(), { type: "model_ring_loaded", ring })!;
    expect(on.modelRing).toEqual(ring);
    expect(selectModelRingReadout(on)).toBe(" · fav 2/2");
    expect(selectModelRingReadout(cloudState())).toBeNull();
    const terminal = { columns: 160, rows: 40 };
    expect(selectMetaBarFit(on, terminal).contextWidth - selectMetaBarFit(cloudState(), terminal).contextWidth).toBe(" · fav 2/2".length);
  });

  it("/model favorite add tells the bar about the new list", () => {
    const dispatch = vi.fn();
    runModelRingCommand({ kind: "add", entry: null }, cloudState(), dispatch, stateDir);
    expect(dispatch).toHaveBeenCalledWith({ type: "model_ring_loaded", ring: { entries: [e("openrouter", "qwen/qwen3.7-max")], sessionOnly: false } });
  });
});
