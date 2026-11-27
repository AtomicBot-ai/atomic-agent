import { describe, expect, it, vi } from "vitest";

import { ConfigValidationError } from "../../../config/config-validation-error.js";
import type { TuiAction } from "../../tui-action.js";

const setLocalFirst = vi.hoisted(() => vi.fn());

vi.mock("../../../config/llm-provider-commands.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../config/llm-provider-commands.js")>();
  return { ...actual, setFallbackLocalFirstInConfig: setLocalFirst };
});

const { FallbackOrchestrator } = await import("./fallback-orchestrator.js");

function makeBus() {
  const emitted: TuiAction[] = [];
  return {
    emitted,
    subscribe: () => () => undefined,
    emit(action: TuiAction) {
      emitted.push(action);
    },
  };
}

/**
 * ATO-2434: a refused `localFirst` write is reported on the Fallback
 * pane's status line through `wrapLlmConfigError`, the same way a refused
 * chain edit is, and nothing is re-mirrored as if it had been saved.
 */
describe("FallbackOrchestrator.setLocalFirst when the write is refused", () => {
  it("puts the reason on the status line and emits no refresh", () => {
    setLocalFirst.mockImplementationOnce(() => {
      throw new ConfigValidationError("llm.fallback.chain[1]", "unknown provider id \"gone\"");
    });
    const bus = makeBus();
    new FallbackOrchestrator(bus).setLocalFirst(true);
    expect(setLocalFirst).toHaveBeenCalledWith(true);
    expect(bus.emitted).toEqual([
      {
        type: "fallback_status",
        line: 'llm.fallback.chain[1]: unknown provider id "gone"',
      },
    ]);
  });
});
