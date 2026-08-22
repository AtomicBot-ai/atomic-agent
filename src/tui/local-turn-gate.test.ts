import { describe, expect, it } from "vitest";

import type { LocalModelsPullState } from "./local-models/local-models-panel-state.js";
import {
  downloadProgressFor,
  evaluateLocalTurnGate,
  reduceChatPull,
  type LocalTurnGateFacts,
} from "./local-turn-gate.js";

const facts = (
  over: Partial<LocalTurnGateFacts> = {},
): LocalTurnGateFacts => ({
  activeProviderIsLocal: true,
  managedMode: true,
  modelId: "qwen-3.5-4b",
  modelDownloaded: false,
  fallbackChainLength: 1,
  ...over,
});

const pull = (
  over: Partial<LocalModelsPullState> = {},
): LocalModelsPullState => ({
  kind: "chat",
  modelId: "qwen-3.5-4b",
  label: "Qwen 3.5 4B (gguf)",
  percent: 53,
  transferredBytes: 2_100_000_000,
  totalBytes: 4_200_000_000,
  error: null,
  ...over,
});

describe("evaluateLocalTurnGate — scope (managed local only)", () => {
  it("runs when the model is on disk", () => {
    expect(
      evaluateLocalTurnGate(facts({ modelDownloaded: true }), null),
    ).toEqual({ kind: "run" });
  });

  it("never gates a cloud text provider, even with the model absent", () => {
    expect(
      evaluateLocalTurnGate(facts({ activeProviderIsLocal: false }), null),
    ).toEqual({ kind: "run" });
  });

  it("never gates external mode — there is no 'on disk' there", () => {
    expect(evaluateLocalTurnGate(facts({ managedMode: false }), null)).toEqual({
      kind: "run",
    });
  });
});

describe("evaluateLocalTurnGate — chain length 1 blocks", () => {
  it("absent model: names the model and the real affordance", () => {
    const decision = evaluateLocalTurnGate(facts(), null);
    expect(decision.kind).toBe("block");
    if (decision.kind !== "block") return;
    expect(decision.text).toContain("qwen-3.5-4b");
    expect(decision.text).toContain("not downloaded");
    expect(decision.text).toContain("/local");
    expect(decision.text).toContain("press Enter");
  });

  it("pull in flight: live percent + bytes instead of 'not downloaded'", () => {
    const decision = evaluateLocalTurnGate(facts(), pull());
    expect(decision.kind).toBe("block");
    if (decision.kind !== "block") return;
    expect(decision.text).toBe(
      "local model qwen-3.5-4b is downloading now — 53% · 2.1 GB / 4.2 GB",
    );
  });

  it("no model ever selected: block points at the picker, not a download", () => {
    const decision = evaluateLocalTurnGate(facts({ modelId: null }), null);
    expect(decision.kind).toBe("block");
    if (decision.kind !== "block") return;
    expect(decision.text).toContain("no local model is selected");
    expect(decision.text).toContain("/local");
  });

  it("a pull for a DIFFERENT model does not count as progress", () => {
    const decision = evaluateLocalTurnGate(
      facts(),
      pull({ modelId: "gemma-4-12b" }),
    );
    expect(decision.kind).toBe("block");
    if (decision.kind !== "block") return;
    expect(decision.text).toContain("not downloaded");
  });

  it("a failed pull is not 'in flight'", () => {
    const decision = evaluateLocalTurnGate(
      facts(),
      pull({ error: "disk full" }),
    );
    expect(decision.kind).toBe("block");
    if (decision.kind !== "block") return;
    expect(decision.text).toContain("not downloaded");
  });
});

describe("evaluateLocalTurnGate — chain length >1 notices, never blocks", () => {
  it("absent model: one-line notice naming the fallback chain", () => {
    const decision = evaluateLocalTurnGate(
      facts({ fallbackChainLength: 2 }),
      null,
    );
    expect(decision.kind).toBe("notice");
    if (decision.kind !== "notice") return;
    expect(decision.text).toContain("fallback chain");
    expect(decision.text).not.toContain("\n");
  });

  it("pull in flight: the notice carries the live progress too", () => {
    const decision = evaluateLocalTurnGate(
      facts({ fallbackChainLength: 2 }),
      pull(),
    );
    expect(decision.kind).toBe("notice");
    if (decision.kind !== "notice") return;
    expect(decision.text).toContain("53% · 2.1 GB / 4.2 GB");
    expect(decision.text).not.toContain("\n");
  });
});

describe("downloadProgressFor", () => {
  it("counts the backend pull for any model — it precedes every model", () => {
    expect(
      downloadProgressFor(
        pull({ kind: "backend", modelId: "_backend", percent: 12 }),
        "qwen-3.5-4b",
      ),
    ).toBe("downloading now — 12% · 2.1 GB / 4.2 GB");
  });

  it("has no honest numbers before content-length arrives", () => {
    expect(
      downloadProgressFor(pull({ totalBytes: 0 }), "qwen-3.5-4b"),
    ).toBe("downloading now…");
  });

  it("ignores embedding pulls and null", () => {
    expect(downloadProgressFor(pull({ kind: "embedding" }), "qwen-3.5-4b")).toBe(
      null,
    );
    expect(downloadProgressFor(null, "qwen-3.5-4b")).toBe(null);
  });
});

describe("reduceChatPull — mirrors the reducer's non-embedding slot", () => {
  it("tracks started → progress → finished", () => {
    let state = reduceChatPull(null, {
      type: "local_models_pull_started",
      pull: pull({ percent: 0, transferredBytes: 0 }),
    });
    expect(state?.percent).toBe(0);
    state = reduceChatPull(state, {
      type: "local_models_pull_progress",
      kind: "chat",
      percent: 53,
      transferredBytes: 2_100_000_000,
      totalBytes: 4_200_000_000,
    });
    expect(state?.percent).toBe(53);
    expect(state?.transferredBytes).toBe(2_100_000_000);
    state = reduceChatPull(state, {
      type: "local_models_pull_finished",
      kind: "chat",
    });
    expect(state).toBe(null);
  });

  it("clears on failure — a dead download must not read as 'in flight'", () => {
    const started = reduceChatPull(null, {
      type: "local_models_pull_started",
      pull: pull(),
    });
    expect(
      reduceChatPull(started, {
        type: "local_models_pull_failed",
        kind: "chat",
        error: "boom",
      }),
    ).toBe(null);
  });

  it("ignores the embedding channel entirely", () => {
    const chat = reduceChatPull(null, {
      type: "local_models_pull_started",
      pull: pull(),
    });
    const after = reduceChatPull(chat, {
      type: "local_models_pull_started",
      pull: pull({ kind: "embedding", modelId: "nomic-embed-text-v1.5" }),
    });
    expect(after).toBe(chat);
    expect(
      reduceChatPull(chat, {
        type: "local_models_pull_finished",
        kind: "embedding",
      }),
    ).toBe(chat);
  });

  it("passes unrelated actions through untouched", () => {
    const chat = reduceChatPull(null, {
      type: "local_models_pull_started",
      pull: pull(),
    });
    expect(reduceChatPull(chat, { type: "abort_requested" })).toBe(chat);
  });
});
