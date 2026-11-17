import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { reduceTuiState } from "../agent-event-reducer.js";
import { ChatLog } from "../chat/chat-log.js";
import { StatusBar } from "../components/status-bar.js";
import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { planUpdateBanner } from "./update-banner.js";
import { blocksNewChat, UPDATE_COMMAND } from "./required-update.js";

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

function offered(required?: "broken" | "below-minimum" | null): TuiState {
  return reduceTuiState(createInitialTuiState(fakeSession()), {
    type: "update_available",
    current: "0.6.10",
    latest: "0.7.1",
    ...(required !== undefined ? { required } : {}),
  });
}

describe("required update (ATO-1125)", () => {
  it("gates only a new chat of a broken version", () => {
    expect(blocksNewChat("broken", 0)).toBe(true);
    expect(blocksNewChat("broken", 3)).toBe(false);
    expect(blocksNewChat("below-minimum", 0)).toBe(false);
    expect(blocksNewChat(null, 0)).toBe(false);
    expect(blocksNewChat(undefined, 0)).toBe(false);
  });

  it("below minimum: the banner warns and the start screen is the usual splash", () => {
    const state = offered("below-minimum");
    const bar = strip(render(<StatusBar state={state} />).lastFrame() ?? "");
    expect(bar).toMatch(/no longer supported|please update/);
    expect(bar).toContain("Update");
    expect(planUpdateBanner("0.7.1", 200, "offer", "below-minimum")?.label).toContain(
      "no longer supported, update to v0.7.1",
    );
    const log = strip(render(<ChatLog state={state} />).lastFrame() ?? "");
    expect(log).not.toContain("Update required");
    expect(log).toContain("/help");
  });

  it("broken: the start screen blocks with the update command", () => {
    const state = offered("broken");
    const log = strip(render(<ChatLog state={state} />).lastFrame() ?? "");
    expect(log).toContain("Update required");
    expect(log).toContain(UPDATE_COMMAND);
    expect(log).not.toContain("/help");
  });

  it("broken: a chat that already has messages keeps its transcript", () => {
    const state: TuiState = {
      ...offered("broken"),
      messages: [{ id: "m1", role: "user", text: "still here", timestamp: 1 }],
    };
    const log = strip(render(<ChatLog state={state} />).lastFrame() ?? "");
    expect(log).toContain("still here");
    expect(log).not.toContain("Update required");
  });

  it("no policy (a plain offer) changes nothing", () => {
    const state = offered();
    expect(state.updateBanner?.required).toBeUndefined();
    const log = strip(render(<ChatLog state={state} />).lastFrame() ?? "");
    expect(log).not.toContain("Update required");
    expect(planUpdateBanner("0.7.1", 200)?.label).toContain("new version");
  });
});
