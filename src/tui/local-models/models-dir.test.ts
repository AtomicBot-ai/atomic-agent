import type { Key } from "ink";
import { describe, expect, it, vi } from "vitest";

import { reduceTuiState } from "../agent-event-reducer.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type TuiSessionInfo, type TuiState } from "../tui-state.js";
import { handleLocalModelsTabKey } from "./local-models-key-bindings.js";
import { ModelsDirOrchestrator, modelsDirTuiWords, parseMoveLine } from "./models-dir-orchestrator.js";
import { modelsDirProgressLine, type ModelsDirAction } from "./models-dir-state.js";

/** ATO-2504: Models › models folder in the TUI. */

const SESSION: TuiSessionInfo = {
  sessionId: null,
  workingDir: "/tmp",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: true,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
    return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
    ...overrides,
  };
}

function modelsTab(): TuiState {
  const s = createInitialTuiState(SESSION);
  return { ...s, uiMode: "debug", activeTab: "models" };
}

function callbacks(extra: Partial<TuiAppCallbacks> = {}): TuiAppCallbacks {
  return { onApprovalDecision: vi.fn(), onAbort: vi.fn(), onQuit: vi.fn(), onMessageSubmitted: vi.fn(), ...extra };
}

function press(state: TuiState, input: string, k: Key, cb: TuiAppCallbacks): TuiState {
  let next = state;
  handleLocalModelsTabKey(input, k, { state, dispatch: (a: TuiAction) => void (next = reduceTuiState(next, a)), callbacks: cb });
  return next;
}

describe("models folder screen keys and state", () => {
  it("F opens the screen and asks the agent where the folder is", () => {
    const load = vi.fn();
    const next = press(modelsTab(), "F", key(), callbacks({ onLocalModelsDirLoadRequested: load }));
    expect(next.localModelsPanel.mode).toBe("modelsDir");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("swallows list hotkeys while the path is typed, and Esc goes back", () => {
    const start = vi.fn();
    let s = press(modelsTab(), "F", key(), callbacks());
    s = press(s, "s", key(), callbacks({ onLocalModelsDaemonStartRequested: start }));
    expect(start).not.toHaveBeenCalled();
    expect(s.localModelsPanel.mode).toBe("modelsDir");
    s = press(s, "", key({ escape: true }), callbacks());
    expect(s.localModelsPanel.mode).toBe("list");
  });

  it("Esc during a move stops it instead of leaving", () => {
    const cancel = vi.fn();
    let s = press(modelsTab(), "F", key(), callbacks());
    s = reduceTuiState(s, { type: "local_models_dir_move_started" });
    s = press(s, "", key({ escape: true }), callbacks({ onLocalModelsDirCancelRequested: cancel }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(s.localModelsPanel.mode).toBe("modelsDir");
  });

  it("keeps the model position when a byte line arrives, and says so", () => {
    let s = reduceTuiState(modelsTab(), { type: "local_models_dir_move_started" });
    s = reduceTuiState(s, { type: "local_models_dir_progress", progress: { entry: "qwen", index: 1, total: 2 } });
    s = reduceTuiState(s, { type: "local_models_dir_progress", progress: { entry: "qwen", index: 0, total: 0, done: 3_100_000_000, size: 12_000_000_000 } });
    expect(modelsDirProgressLine(s.localModelsPanel.modelsDir.progress)).toBe("moving qwen (1 of 2) · 3.1 GB of 12.0 GB");
    s = reduceTuiState(s, { type: "local_models_dir_move_finished", note: "Moved." });
    expect(s.localModelsPanel.modelsDir).toMatchObject({ moving: false, progress: null, note: "Moved." });
  });
});

describe("ModelsDirOrchestrator", () => {
  it("parses the command's progress lines", () => {
    expect(parseMoveLine("moving qwen (2/5)")).toEqual({ entry: "qwen", index: 2, total: 5 });
    expect(parseMoveLine("copied 10 of 20 bytes (qwen)")).toEqual({ entry: "qwen", index: 0, total: 0, done: 10, size: 20 });
    expect(parseMoveLine("models folder: /x")).toBeNull();
  });

  it("says refusals with the TUI's keys", () => {
    expect(modelsDirTuiWords("models dir: a local model is running; stop it first (atomic-agent models stop)\n")).toMatch(/s on the list/);
    expect(modelsDirTuiWords("models dir: the models folder /V is not there (is its disk connected?); x\n")).toMatch(/not connected/);
  });

  it("runs the move in the model-operation turn with a signal, then reloads and refreshes", async () => {
    const emitted: ModelsDirAction[] = [];
    const calls: Array<{ args: readonly string[]; signal: boolean }> = [];
    let inTurn = 0;
    const refresh = vi.fn();
    const o = new ModelsDirOrchestrator({
      emit: (a) => void emitted.push(a),
      inTurn: async (body) => {
        inTurn += 1;
        await body(new AbortController().signal);
      },
      refresh,
      run: async (args, deps) => {
        calls.push({ args, signal: deps.signal !== undefined });
        if (args[0] === "--json") {
          deps.write?.(`${JSON.stringify({ dir: "/USB/models", defaultDir: "/d", custom: true, reachable: true })}\n`);
          return 0;
        }
        deps.write?.("moving qwen (1/1)\n");
        deps.write?.("copied 5 of 10 bytes (qwen)\n");
        deps.write?.("models folder: /USB/models\n");
        return 0;
      },
    });
    await o.move("  /USB/models ");
    expect(inTurn).toBe(1);
    expect(calls[0]).toEqual({ args: ["/USB/models"], signal: true });
    expect(emitted.map((a) => a.type)).toEqual([
      "local_models_dir_move_started",
      "local_models_dir_progress",
      "local_models_dir_progress",
      "local_models_dir_move_finished",
      "local_models_dir_loaded",
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("an empty line resets, and Esc aborts the signal the command got", async () => {
    let seen: AbortSignal | undefined;
    const emitted: ModelsDirAction[] = [];
    const o = new ModelsDirOrchestrator({
      emit: (a) => void emitted.push(a),
      inTurn: (body) => body(new AbortController().signal),
      refresh: () => {},
      run: async (args, deps) => {
        if (args[0] === "--json") return 1;
        expect(args).toEqual(["--reset"]);
        seen = deps.signal;
        o.cancel();
        deps.writeErr?.("models dir: the move was stopped; every model is back in the old folder\n");
        return 1;
      },
    });
    await o.move("");
    expect(seen?.aborted).toBe(true);
    expect(emitted).toContainEqual({ type: "local_models_dir_move_stopping" });
    expect(emitted).toContainEqual({ type: "local_models_dir_move_failed", error: "The move was stopped; every model is back in the old folder" });
  });
});
