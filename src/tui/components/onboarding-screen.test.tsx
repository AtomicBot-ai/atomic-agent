import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OnboardingScreen } from "./onboarding-screen.js";
import { resetConfigCache } from "../../config/index.js";
import { createOnboardingState } from "../onboarding/onboarding-state.js";
import { createInitialTuiState } from "../tui-state.js";
import type { TuiAction } from "../tui-action.js";
import { fakeSession } from "../test-fixtures.js";

vi.mock("../../llm/llama-server-health.js", () => ({
  checkLlamaServer: vi.fn(async () => ({
    reachable: false,
    status: null,
    kind: "unknown",
    error: "connect ECONNREFUSED 127.0.0.1:8080",
    latencyMs: 1,
  })),
}));

const STATE_DIR_ENV = "ATOMIC_AGENT_STATE_DIR";
/** A pull in flight, so the wait-or-jump step has a bar to draw. */
const PULL = {
  kind: "chat",
  modelId: "gemma-4-e4b",
  label: "Gemma 4 E4B",
  percent: 61,
  transferredBytes: 2_600_000_000,
  totalBytes: 4_220_000_000,
  error: null,
} as const;
const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");
const ESCAPE_KEY = "\u001b";

type FlowStep = "intro" | "choose" | "custom_chat_url" | "wait_or_jump";

function renderFlow(
  step: FlowStep = "choose",
  cursor = 0,
  panel: { pull?: typeof PULL | null; errorLine?: string | null } = {},
) {
  const actions: TuiAction[] = [];
  const pullRequests: string[] = [];
  const onboarding = {
    ...createOnboardingState("http://127.0.0.1:8080"),
    step,
    cursor,
    localModelId: "gemma-4-e4b",
  };
  const base = createInitialTuiState(fakeSession(), 50);
  const state = {
    ...base,
    localModelsPanel: {
      ...base.localModelsPanel,
      pull: panel.pull === undefined ? PULL : panel.pull,
      errorLine: panel.errorLine ?? null,
    },
    onboarding,
  };
  const view = render(
    <OnboardingScreen
      state={state}
      onboarding={onboarding}
      dispatch={(action) => actions.push(action)}
      callbacks={{
        onLocalModelsPullRequested: (modelId) => pullRequests.push(modelId),
      }}
    />,
  );
  return { view, actions, pullRequests };
}

describe("OnboardingScreen", () => {
  let stateDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "onboarding-screen-"));
    mkdirSync(stateDir, { recursive: true });
    originalEnv = process.env[STATE_DIR_ENV];
    process.env[STATE_DIR_ENV] = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = originalEnv;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("draws the three choices, the brand lockup and nothing of the app chrome", () => {
    const { view } = renderFlow();
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("atomic");
    expect(frame).toContain("setup \u00b7 step 1 of 2");
    expect(frame).toContain("Local models");
    expect(frame).toContain("Cloud models");
    expect(frame).toContain("Custom endpoint");
    // What each one costs the operator, on the screen rather than behind it.
    expect(frame).toContain("Private, free per token");
    expect(frame).toContain("needs an API key");
    expect(frame).toContain("Nothing is downloaded");
    // The copy describes a choice, not the health probe that used to
    // bring this screen up.
    expect(frame).not.toContain("not reachable");
    expect(frame).not.toContain("ECONNREFUSED");
    // The chrome the flow deliberately does not borrow.
    expect(frame).not.toContain("R U N");
    expect(frame).not.toContain("SESSIONS");
    expect(frame).not.toContain("Ask anything");
  });

  it("keeps the hint strip as the last row", () => {
    const { view } = renderFlow();
    const lines = strip(view.lastFrame() ?? "").split("\n");
    const last = lines.filter((line) => line.trim().length > 0).at(-1) ?? "";
    expect(last).toContain("move");
    expect(last).toContain("ctrl+c quit");
  });

  it("names the step it is on", () => {
    const { view } = renderFlow("custom_chat_url");
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("custom endpoint \u00b7 step 2 of 2");
    expect(frame).toContain("must answer GET /health");
  });

  it("treats Esc as a recorded skip rather than a silent one", async () => {
    const { view, actions } = renderFlow();
    view.stdin.write(ESCAPE_KEY);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(actions).toContainEqual({ type: "onboarding_finished", outcome: "skipped" });
  });

  it("opens on the splash: mark, wordmark, tagline and the promise it makes", () => {
    const { view } = renderFlow("intro");
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("\u2588"); // the mark
    expect(frame).toContain("press any key to continue");
    // The wordmark's first row, `ATOMIC` only — not `ATOMIC AGENT`.
    expect(frame).toContain("\u2584\u2580\u2588 \u2580\u2588\u2580 \u2588\u2580\u2588");
    expect(frame).not.toContain("setup \u00b7 step 1 of 2");
  });

  it("takes two keys off the splash: one to finish the reveal, one to move on", async () => {
    const { view, actions } = renderFlow("intro");
    view.stdin.write("x");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(actions).toEqual([]);
    view.stdin.write("x");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(actions).toContainEqual({ type: "onboarding_step_set", step: "choose" });
  });

  it("does not let Esc skip setup from a screen that has not offered it yet", async () => {
    const { view, actions } = renderFlow("intro");
    view.stdin.write(ESCAPE_KEY);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(actions).not.toContainEqual({ type: "onboarding_finished", outcome: "skipped" });
  });

  describe("the almost-there screen", () => {
    it("draws the bar it promises and drops the row that only waits", () => {
      const { view } = renderFlow("wait_or_jump");
      const frame = strip(view.lastFrame() ?? "");
      expect(frame).toContain("almost there");
      expect(frame).toContain("Still downloading gemma-4-e4b");
      expect(frame).toContain("61%");
      expect(frame).toContain("2.6 GB / 4.2 GB");
      expect(frame).toContain("\u2588");
      expect(frame).toContain("Start using the agent now");
      expect(frame).toContain("Add another cloud provider");
      expect(frame).not.toContain("Wait here");
      const last = frame.split("\n").filter((line) => line.trim().length > 0).at(-1) ?? "";
      expect(last).toContain("start or add a provider");
    });

    it("leaves for the agent on the first row", async () => {
      const { view, actions } = renderFlow("wait_or_jump");
      view.stdin.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(actions).toContainEqual({ type: "onboarding_finished", outcome: "cloud" });
    });

    it("opens the providers wizard again on the second row", async () => {
      const { view, actions } = renderFlow("wait_or_jump", 1);
      view.stdin.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(actions.map((action) => action.type)).toEqual([
        "providers_wizard_opened",
        "onboarding_cloud_meanwhile_opened",
      ]);
    });

    it("moves between the two rows", async () => {
      const { view, actions } = renderFlow("wait_or_jump");
      view.stdin.write("j");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(actions).toContainEqual({
        type: "onboarding_cursor_moved",
        delta: 1,
        length: 2,
      });
    });

    it("says the local model landed once the pull is gone without an error", () => {
      const { view } = renderFlow("wait_or_jump", 0, { pull: null });
      const frame = strip(view.lastFrame() ?? "");
      expect(frame).toContain("local model is ready");
      expect(frame).not.toContain("Still downloading");
      expect(frame).not.toContain("starting");
      expect(frame).not.toContain("waiting");
    });

    it("offers a third row after a failed pull, and enter on it re-runs the pull", async () => {
      const { view, actions, pullRequests } = renderFlow("wait_or_jump", 2, {
        pull: null,
        errorLine: "connection reset",
      });
      const frame = strip(view.lastFrame() ?? "");
      expect(frame).toContain("download failed");
      expect(frame).toContain("connection reset");
      expect(frame).toContain("Retry the download");
      view.stdin.write("j");
      await new Promise((resolve) => setTimeout(resolve, 30));
      // Three rows now, and the keyboard knows it.
      expect(actions).toContainEqual({
        type: "onboarding_cursor_moved",
        delta: 1,
        length: 3,
      });
      view.stdin.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(pullRequests).toEqual(["gemma-4-e4b"]);
    });
  });

  it("moves the cursor on a keypress", async () => {
    const { view, actions } = renderFlow();
    view.stdin.write("j");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(actions).toContainEqual({ type: "onboarding_cursor_moved", delta: 1 });
  });
});
