import { describe, it, expect } from "vitest";
import {
  createInitialTuiState,
  type TuiSessionInfo,
  type TuiState,
} from "../tui-state.js";
import { reduceMemoryAction as reduceMemoryActionRaw } from "./memory-reducer.js";
import type { TuiAction } from "../tui-action.js";
import { fakeSession } from "../test-fixtures.js";
import { createInitialMemoryPanelState } from "./memory-panel-state.js";

// Keep the original reducer function, with actual action payload checking in fixtures.
const reduceMemoryAction: (state: TuiState, action: TuiAction) => TuiState | null =
  reduceMemoryActionRaw;

const session: TuiSessionInfo = fakeSession({
  sessionId: "s1",
  workingDir: "/tmp",
  llamaUrl: "http://127.0.0.1:8080",
  skillCount: 0,
});

function baseState() {
  return createInitialTuiState(session);
}

describe("reduceMemoryAction", () => {
  it("returns null for unrelated actions", () => {
    expect(
      reduceMemoryAction(baseState(), { type: "chat_cleared" }),
    ).toBeNull();
  });

  it("loads rows and clamps cursor", () => {
    let state = baseState();
    state = reduceMemoryAction(state, {
      type: "memory_rows_loaded",
      rows: [
        {
          rowKey: "profile:a",
          channel: "profile",
          primary: "a",
          secondary: "v",
          meta: "",
          profileKey: "a",
        },
      ],
      availableChannels: ["profile"],
      channelHint: null,
      at: 1,
    })!;
    expect(state.memoryPanel.rows).toHaveLength(1);
    expect(state.memoryPanel.loading).toBe(false);
  });

  it("opens and closes detail", () => {
    let state = baseState();
    state = reduceMemoryAction(state, {
      type: "memory_detail_opened",
      rowKey: "profile:k",
      detail: { channel: "profile", key: "k", body: "line" },
    })!;
    expect(state.memoryPanel.mode).toBe("detail");
    state = reduceMemoryAction(state, { type: "memory_detail_closed" })!;
    expect(state.memoryPanel.mode).toBe("list");
    expect(state.memoryPanel.detail).toBeNull();
  });

  it("cycles channel and resets detail", () => {
    let state: TuiState = {
      ...baseState(),
      memoryPanel: {
        ...createInitialMemoryPanelState(),
        mode: "detail" as const,
        detail: { channel: "profile" as const, key: "k", body: "x" },
      },
    };
    state.memoryPanel = {
      ...state.memoryPanel,
      availableChannels: ["profile", "notes"],
    };
    state = reduceMemoryAction(state, {
      type: "memory_channel_cycled",
      direction: 1,
    })!;
    expect(state.memoryPanel.mode).toBe("list");
    expect(state.memoryPanel.channel).toBe("notes");
  });
});
