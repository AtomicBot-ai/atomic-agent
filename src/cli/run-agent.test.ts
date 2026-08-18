import { describe, expect, it } from "vitest";

import { formatLlamaUnreachableHint } from "../llm/llama-server-health.js";
import { formatAgentEvent } from "./run-agent.js";

const HINT = formatLlamaUnreachableHint("http://127.0.0.1:8080");

function transportError(message: string) {
  return {
    type: "llm_event" as const,
    event: {
      type: "step_error" as const,
      error: new Error(message),
      category: "transport" as const,
    },
  };
}

describe("formatAgentEvent llama hint", () => {
  it("turns a bare transport failure into something actionable on the local route", () => {
    const line = formatAgentEvent(transportError("fetch failed"), {
      llamaHint: HINT,
      hintShown: { value: false },
    });
    expect(line).toContain("! [transport] fetch failed");
    expect(line).toContain("llama-server is not reachable at http://127.0.0.1:8080");
    expect(line).toContain("atomic-agent models start");
    expect(line).toContain("config set localModels.url");
  });

  it("prints the hint once, not on every retry", () => {
    const hintShown = { value: false };
    const first = formatAgentEvent(transportError("fetch failed"), {
      llamaHint: HINT,
      hintShown,
    });
    const second = formatAgentEvent(transportError("fetch failed"), {
      llamaHint: HINT,
      hintShown,
    });
    expect(first).toContain("llama-server is not reachable");
    expect(second).toBe("  ! [transport] fetch failed");
  });

  it("stays out of the way on a cloud route", () => {
    // No hint is computed when the active text provider is not local —
    // a transport failure there points at the provider, not at llama.
    const line = formatAgentEvent(transportError("fetch failed"), {
      llamaHint: null,
      hintShown: { value: false },
    });
    expect(line).toBe("  ! [transport] fetch failed");
  });

  it("stays out of the way for non-transport failures", () => {
    const line = formatAgentEvent(
      {
        type: "llm_event",
        event: {
          type: "step_error",
          error: new Error("grammar rejected the completion"),
          category: "model" as never,
        },
      },
      { llamaHint: HINT, hintShown: { value: false } },
    );
    expect(line).toBe("  ! [model] grammar rejected the completion");
  });

  it("decorates loop_failed the same way", () => {
    const line = formatAgentEvent(
      {
        type: "loop_failed",
        error: new Error("fetch failed"),
        category: "transport" as never,
      },
      { llamaHint: HINT, hintShown: { value: false } },
    );
    expect(line).toContain("» loop failed [transport]: fetch failed");
    expect(line).toContain("llama-server is not reachable");
  });
});

describe("formatLlamaUnreachableHint", () => {
  it("names the URL, the start command and the config key", () => {
    const hint = formatLlamaUnreachableHint("http://10.0.0.4:9090");
    expect(hint).toContain("http://10.0.0.4:9090");
    expect(hint).toContain("atomic-agent models start");
    expect(hint).toContain("localModels.url");
  });
});
