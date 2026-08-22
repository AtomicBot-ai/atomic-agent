import { describe, expect, it } from "vitest";

import type { LlmHealthStatus } from "../llm-health/llm-health-state.js";
import type { TuiState } from "../tui-state.js";
import { formatRssGb, selectComposerLocalStatus } from "./composer-local-status.js";
import { cloudState, localState } from "./composer-switch-fixtures.js";

function withHealth(
  base: TuiState,
  status: LlmHealthStatus,
  daemonRssBytes: number | null = null,
): TuiState {
  return {
    ...base,
    llmHealth: { ...base.llmHealth, status, daemonRssBytes },
  };
}

describe("the composer's daemon-status control", () => {
  it("exists only on the managed-local route", () => {
    expect(selectComposerLocalStatus(withHealth(cloudState(), "healthy"))).toBe(
      null,
    );
    expect(
      selectComposerLocalStatus(withHealth(localState("external"), "healthy")),
    ).toBe(null);
    expect(
      selectComposerLocalStatus(withHealth(localState(), "healthy")),
    ).toEqual({ word: "healthy", ramLabel: null });
  });

  // The verifier's mapping, verbatim: the daemon slice only refreshes
  // while the Models tab is open, so the always-fresh `llmHealth` probe
  // carries the terminal words and the stale-but-optimistic phase flags
  // only ever add "starting".
  const probeWords: readonly [LlmHealthStatus, string | null][] = [
    ["probing", "starting"],
    ["healthy", "healthy"],
    ["unreachable", "down"],
    ["error", "down"],
    // Nothing probed yet: silence, not a grey dot.
    ["unknown", null],
  ];
  for (const [status, word] of probeWords) {
    it(`reads a ${status} probe as ${word ?? "no control at all"}`, () => {
      const got = selectComposerLocalStatus(withHealth(localState(), status));
      if (word === null) expect(got).toBe(null);
      else expect(got?.word).toBe(word);
    });
  }

  it("says starting while the operator's own start is still settling", () => {
    const base = withHealth(localState(), "unreachable");
    const state: TuiState = {
      ...base,
      localModelsPanel: { ...base.localModelsPanel, daemonPhase: "starting" },
    };
    expect(selectComposerLocalStatus(state)?.word).toBe("starting");
  });

  it("says starting while the daemon is still loading the model", () => {
    const base = withHealth(localState(), "healthy");
    const state: TuiState = {
      ...base,
      localModelsPanel: {
        ...base.localModelsPanel,
        daemon: { ...base.localModelsPanel.daemon, loading: true },
      },
    };
    expect(selectComposerLocalStatus(state)?.word).toBe("starting");
  });

  it("appends the sampled RSS when there is a managed pid behind it", () => {
    expect(
      selectComposerLocalStatus(withHealth(localState(), "healthy", 4.4e9)),
    ).toEqual({ word: "healthy", ramLabel: "4.4 GB" });
  });

  it("drops the RAM segment when there is nothing to measure", () => {
    // External mode has no child of ours, a down daemon has no pid —
    // both arrive here the same way: a `null` sample.
    expect(
      selectComposerLocalStatus(withHealth(localState(), "unreachable", null)),
    ).toEqual({ word: "down", ramLabel: null });
  });
});

describe("the RSS label", () => {
  it("uses the catalog's decimal-GB vocabulary", () => {
    expect(formatRssGb(4_400_000_000)).toBe("4.4 GB");
    expect(formatRssGb(512_000_000)).toBe("0.5 GB");
  });
});
