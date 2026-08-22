import { describe, expect, it } from "vitest";

import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { cloudState, localModelDef, localState } from "./composer-switch-fixtures.js";
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

  it("lists only downloaded models, then the download deep link, on local", () => {
    const base = localState();
    const state: TuiState = {
      ...base,
      localModelsPanel: {
        ...base.localModelsPanel,
        rows: [
          ...base.localModelsPanel.rows,
          // A catalog entry not on disk: listing it would put a
          // multi-gigabyte pull one Enter from "switch model".
          {
            id: "qwen-3.5-30b" as (typeof base.localModelsPanel.rows)[number]["id"],
            def: localModelDef("qwen-3.5-30b"),
            downloaded: false,
            active: false,
            mmprojStatus: "n/a" as const,
          },
        ],
      },
    };
    const rows = selectComposerSwitchRows(state, "model");
    expect(rows.map((row) => row.label)).toEqual([
      "qwen-3.5-4b",
      "Download more models…",
    ]);
    expect(rows[0]?.intent).toMatchObject({
      kind: "llmRow",
      row: { kind: "localTextModel" },
    });
    expect(rows.at(-1)?.intent).toEqual({ kind: "localModelsPanel" });
  });

  it("shows a loading row while the local slice has never landed", () => {
    // Fresh boot: the slice is only refreshed by the Models/LLM tab's
    // loop (plus the switch-open effect), so `rows` being empty says
    // nothing about the disk yet — an empty list would read as
    // "nothing downloaded" on exactly the installs that have models.
    const base = localState();
    const state: TuiState = {
      ...base,
      localModelsPanel: { ...base.localModelsPanel, rows: [] },
    };
    const rows = selectComposerSwitchRows(state, "model");
    expect(rows.map((row) => row.label)).toEqual([
      "loading…",
      "Download more models…",
    ]);
  });

  it("drops the loading row once a snapshot reports nothing on disk", () => {
    const base = localState();
    const state: TuiState = {
      ...base,
      localModelsPanel: {
        ...base.localModelsPanel,
        rows: [],
        lastRefreshedAt: Date.now(),
      },
    };
    expect(
      selectComposerSwitchRows(state, "model").map((row) => row.label),
    ).toEqual(["Download more models…"]);
  });

  it("keeps the full catalog, download offers included, on custom", () => {
    // The custom route's model switch predates this split and still
    // shows the whole managed catalog — the local-mode filtering must
    // not leak into it.
    const rows = selectComposerSwitchRows(localState("external"), "model");
    expect(rows.map((row) => row.label)).toEqual(["qwen-3.5-4b"]);
    expect(rows.some((row) => row.intent.kind === "localModelsPanel")).toBe(
      false,
    );
  });

  it("narrows to the open switch's typed filter, terms ANDed", () => {
    // codex subscription-cli: the one cloud kind whose model list is
    // exactly the entry's own options, so the bundled catalogs cannot
    // leak extra rows into the counts below.
    const base = cloudState({
      id: "codex",
      kind: "subscription-cli",
      subscriptionCli: { cli: "codex" },
      chatModelOptions: [
        "qwen/qwen3.7-max",
        "qwen/qwen3-coder",
        "anthropic/claude-opus-5",
      ],
      chatModel: "qwen/qwen3.7-max",
    });
    const state: TuiState = {
      ...base,
      composerSwitch: { kind: "model", cursor: 0, filter: "qwen coder" },
    };
    expect(selectComposerSwitchRows(state, "model").map((r) => r.label)).toEqual(
      ["qwen/qwen3-coder"],
    );
    // The filter belongs to the switch that is open, never to a sibling.
    expect(selectComposerSwitchRows(state, "provider").length).toBe(3);
  });

  it("matches on the detail column when the label cannot answer", () => {
    const base = cloudState();
    const state: TuiState = {
      ...base,
      composerSwitch: { kind: "provider", cursor: 0, filter: "wizard" },
    };
    // "opens the wizard" is the detail of the add-provider row.
    expect(
      selectComposerSwitchRows(state, "provider").map((r) => r.label),
    ).toEqual(["Add a new provider"]);
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
