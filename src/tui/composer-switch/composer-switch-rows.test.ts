import { describe, expect, it } from "vitest";

import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { cloudState, localState } from "./composer-switch-fixtures.js";
import {
  initialComposerSwitchCursor,
  selectComposerBackend,
  selectComposerBackendMeta,
  selectComposerSwitchRows,
} from "./composer-switch-rows.js";

describe("which backend the route is on", () => {
  const cases: readonly [string, () => TuiState, string][] = [
    ["an active cloud provider", () => cloudState(), "cloud"],
    ["the managed llama.cpp", () => localState("managed"), "local"],
    ["a llama.cpp the operator runs", () => localState("external"), "custom"],
    // `localModels.mode` defaults to `external` in config, so an
    // untouched install genuinely is pointed at a llama.cpp this app does
    // not manage — at the default `127.0.0.1:8080`. Reading that as
    // `local` would claim a managed backend nobody set up.
    [
      "nothing configured at all",
      () => createInitialTuiState(fakeSession()),
      "custom",
    ],
  ];
  for (const [name, build, expected] of cases) {
    it(`reads ${name} as ${expected}`, () => {
      expect(selectComposerBackend(build())).toBe(expected);
    });
  }
});

describe("the backend control's dot", () => {
  it("stays quiet until a local backend is really the route", () => {
    expect(selectComposerBackendMeta(localState()).status).toBe("unknown");
  });

  it("reports the live probe once local is configured", () => {
    const base = localState();
    const state = {
      ...base,
      llmHealth: {
        ...base.llmHealth,
        localConfigured: true,
        status: "unreachable" as const,
      },
    };
    expect(selectComposerBackendMeta(state)).toEqual({
      kind: "local",
      status: "unreachable",
    });
  });

  it("does not invent a fault for a cloud route", () => {
    expect(selectComposerBackendMeta(cloudState()).status).toBe("healthy");
  });
});

describe("the switch rows", () => {
  it("offers exactly cloud, local and custom, marking the live one", () => {
    const rows = selectComposerSwitchRows(localState("external"), "backend");
    expect(rows.map((row) => row.label)).toEqual(["cloud", "local", "custom"]);
    expect(rows.filter((row) => row.active).map((row) => row.label)).toEqual([
      "custom",
    ]);
  });

  it("lists the configured providers and an entry that adds one", () => {
    const rows = selectComposerSwitchRows(cloudState(), "provider");
    expect(rows.map((row) => row.label)).toEqual([
      "openrouter",
      "aimlapi",
      "Add a new provider",
    ]);
    expect(rows[0]?.active).toBe(true);
    // A provider with no key still lists — its row configures rather
    // than activates, which is what `cloudProviderRow` already decides.
    expect(rows[1]?.detail).toBe("no API key");
    expect(rows[2]?.intent).toEqual({ kind: "addProvider" });
  });

  it("lists the active cloud provider's catalog as model rows", () => {
    const rows = selectComposerSwitchRows(cloudState(), "model");
    expect(rows[0]).toMatchObject({
      label: "qwen/qwen3.7-max",
      active: true,
      intent: { kind: "llmRow" },
    });
    expect(
      rows.every(
        (row) =>
          row.intent.kind === "llmRow" &&
          row.intent.row.kind === "cloudChatModel",
      ),
    ).toBe(true);
  });

  it("lists the local models on disk when local is the route", () => {
    const rows = selectComposerSwitchRows(localState(), "model");
    expect(rows.map((row) => row.label)).toEqual(["qwen-3.5-4b"]);
    expect(rows[0]?.intent).toMatchObject({
      kind: "llmRow",
      row: { kind: "localTextModel" },
    });
  });

  it("is unaffected by a filter left typed in the Cloud pane", () => {
    const base = cloudState();
    const filtered = {
      ...base,
      llmPanel: { ...base.llmPanel, cloudModelFilter: "nothing-matches-this" },
    };
    expect(selectComposerSwitchRows(filtered, "model").length).toBe(
      selectComposerSwitchRows(base, "model").length,
    );
  });
});

describe("where an opened switch lands", () => {
  it("puts the cursor on the choice already in effect", () => {
    expect(initialComposerSwitchCursor(localState("external"), "backend")).toBe(2);
    expect(initialComposerSwitchCursor(cloudState(), "backend")).toBe(0);
  });

  it("falls back to the top row when nothing is active", () => {
    const state = createInitialTuiState(fakeSession());
    expect(initialComposerSwitchCursor(state, "provider")).toBe(0);
  });
});
