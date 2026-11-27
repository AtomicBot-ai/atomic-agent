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
import { cycleModelRing, runModelRingCommand } from "./model-ring-actions.js";
import { readModelRing, writeModelRing } from "./model-ring-store.js";

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
