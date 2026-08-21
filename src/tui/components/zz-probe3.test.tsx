import { render } from "ink-testing-library";
import React from "react";
import { describe, it } from "vitest";
import { LlmPanel } from "./llm-panel.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";

function st(): TuiState {
  return createInitialTuiState(
    {
      sessionId: "s1",
      workingDir: "/tmp/smoke",
      llamaUrl: "http://127.0.0.1:8080",
      browserChannel: "chrome",
      browserHeadless: false,
      approvalLevel: 5,
      maxSteps: 10,
      skillCount: 0,
    },
    500,
    { uiMode: "debug", activeTab: "llm" },
  );
}

describe("llm panel budget sweep", () => {
  it("sweeps", () => {
    for (let budget = 6; budget <= 34; budget += 1) {
      const { lastFrame } = render(<LlmPanel state={st()} maxRows={budget} />);
      const n = (lastFrame() ?? "").replace(/\n$/, "").split("\n").length;
      // eslint-disable-next-line no-console
      console.log(
        `SWEEP budget=${budget} rendered=${n} ${n > budget ? "OVER" : ""}`,
      );
    }
  }, 120000);
});
