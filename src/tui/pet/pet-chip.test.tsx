import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { StatusBar } from "../components/status-bar.js";
import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState } from "../tui-state.js";

describe("terminal pet in the top bar (ATO-2513)", () => {
  it("is not there by default", () => {
    const state = createInitialTuiState(fakeSession());
    const { lastFrame } = render(<StatusBar state={state} brand={false} />);
    expect(lastFrame() ?? "").not.toContain("(o.o)");
  });

  it("shows its face and what the agent does once /pet turned it on", () => {
    const state = { ...createInitialTuiState(fakeSession()), pet: true };
    const { lastFrame } = render(<StatusBar state={state} brand={false} />);
    expect(lastFrame() ?? "").toContain("(o.o)");
    expect(lastFrame() ?? "").toContain("idle");
  });
});
