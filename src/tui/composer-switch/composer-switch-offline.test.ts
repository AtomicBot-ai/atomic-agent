import { describe, expect, it } from "vitest";

import type { TuiState } from "../tui-state.js";
import {
  cloudState,
  fusionState,
  localState,
  providerRow,
} from "./composer-switch-fixtures.js";
import {
  gateRowsForOffline,
  OFFLINE_ROW_REASON,
  providerRunsOnThisMachine,
} from "./composer-switch-offline.js";
import { activateComposerSwitchRow } from "./composer-switch-activate.js";
import {
  backendSwitchRow,
  selectComposerSwitchRows,
} from "./composer-switch-rows.js";
import type { ComposerSwitchRow } from "./composer-switch-row-contracts.js";

function byLabel(rows: readonly ComposerSwitchRow[], label: string): ComposerSwitchRow {
  const row = rows.find((candidate) => candidate.label === label);
  if (!row) throw new Error(`no row ${label}`);
  return row;
}

function withSession(state: TuiState, llamaUrl: string): TuiState {
  return { ...state, session: { ...state.session, llamaUrl } };
}

describe("which providers answer from this machine", () => {
  it("counts the managed llama.cpp and a loopback base URL as local", () => {
    expect(providerRunsOnThisMachine(providerRow({ kind: "llama-server" }))).toBe(true);
    expect(
      providerRunsOnThisMachine(
        providerRow({ kind: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1" }),
      ),
    ).toBe(true);
    expect(
      providerRunsOnThisMachine(
        providerRow({ kind: "openai-compatible", baseUrl: "http://localhost:11434/v1" }),
      ),
    ).toBe(true);
  });

  it("counts curated clouds, remote URLs and subscription CLIs as cloud", () => {
    expect(providerRunsOnThisMachine(providerRow())).toBe(false);
    expect(
      providerRunsOnThisMachine(
        providerRow({ kind: "openai-compatible", baseUrl: "https://api.example.com/v1" }),
      ),
    ).toBe(false);
    expect(
      providerRunsOnThisMachine(
        providerRow({
          kind: "subscription-cli",
          baseUrl: "http://127.0.0.1:9/",
          subscriptionCli: { cli: "claude" },
        }),
      ),
    ).toBe(false);
  });
});

describe("the backend switch while offline", () => {
  it("is unchanged while offline mode is off", () => {
    const state = cloudState();
    const online = selectComposerSwitchRows(state, "backend", false);
    expect(online.some((row) => row.disabled)).toBe(false);
  });

  it("greys out cloud and fusion, keeps local and a loopback custom", () => {
    const rows = selectComposerSwitchRows(fusionState(), "backend", true);
    expect(byLabel(rows, "cloud").disabled).toBe(OFFLINE_ROW_REASON);
    expect(byLabel(rows, "cloud").detail).toBe(OFFLINE_ROW_REASON);
    expect(byLabel(rows, "fusion").disabled).toBe(OFFLINE_ROW_REASON);
    expect(byLabel(rows, "local").disabled).toBeUndefined();
    expect(byLabel(rows, "custom").disabled).toBeUndefined();
  });

  it("greys out a custom llama.cpp on another machine", () => {
    const state = withSession(localState("external"), "http://192.168.1.20:8080");
    const rows = selectComposerSwitchRows(state, "backend", true);
    expect(byLabel(rows, "custom").disabled).toBe(OFFLINE_ROW_REASON);
  });

  it("keeps cloud usable when a configured provider is on this machine", () => {
    const state = cloudState({
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:1234/v1",
    });
    const rows = selectComposerSwitchRows(state, "backend", true);
    expect(byLabel(rows, "cloud").disabled).toBeUndefined();
  });

  it("gates the row /runmode activates the same way", () => {
    expect(backendSwitchRow(cloudState(), "cloud", true).disabled).toBe(OFFLINE_ROW_REASON);
    expect(backendSwitchRow(cloudState(), "local", true).disabled).toBeUndefined();
  });
});

describe("the provider and model switches while offline", () => {
  it("greys out cloud providers and keeps the add row", () => {
    const rows = selectComposerSwitchRows(cloudState(), "provider", true);
    expect(byLabel(rows, "openrouter").disabled).toBe(OFFLINE_ROW_REASON);
    expect(byLabel(rows, "Add a new provider").disabled).toBeUndefined();
  });

  it("leaves local model rows alone", () => {
    const rows = selectComposerSwitchRows(localState(), "model", true);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.disabled)).toBe(false);
  });

  it("greys out a cloud fusion leg but not the local one", () => {
    const state = fusionState();
    const rows = gateRowsForOffline(
      [
        {
          id: "leg:cloud",
          label: "openrouter",
          detail: "",
          active: false,
          intent: { kind: "fusionLeg", leg: "orchestrator", providerId: "openrouter" },
        },
        {
          id: "leg:local",
          label: "local-llama",
          detail: "",
          active: false,
          intent: { kind: "fusionLeg", leg: "worker", providerId: "local-llama" },
        },
      ],
      state,
      true,
    );
    expect(rows[0]?.disabled).toBe(OFFLINE_ROW_REASON);
    expect(rows[1]?.disabled).toBeUndefined();
  });
});

describe("choosing a greyed-out row", () => {
  it("only says why, and calls nothing", () => {
    const row = backendSwitchRow(cloudState(), "cloud", true);
    const actions: unknown[] = [];
    let called = false;
    const callbacks = new Proxy(
      {},
      {
        get: () => () => {
          called = true;
        },
      },
    );
    activateComposerSwitchRow(
      row,
      cloudState(),
      (action) => actions.push(action),
      callbacks as never,
    );
    expect(actions).toEqual([{ type: "composer_notice", text: OFFLINE_ROW_REASON }]);
    expect(called).toBe(false);
  });
});
