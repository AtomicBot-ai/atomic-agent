import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OnboardingScreen } from "./onboarding-screen.js";
import { resetConfigCache } from "../../config/index.js";
import { createOnboardingState } from "../onboarding/onboarding-state.js";
import { createProvidersWizardState } from "../providers/providers-wizard-state.js";
import type { ProvidersWizardState } from "../providers/providers-wizard-state.js";
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
const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");
const ESCAPE_KEY = "\u001b";

function renderFlow(step: "intro" | "choose" | "custom_chat_url" = "choose") {
  const actions: TuiAction[] = [];
  const onboarding = { ...createOnboardingState("http://127.0.0.1:8080"), step };
  const state = { ...createInitialTuiState(fakeSession(), 50), onboarding };
  const view = render(
    <OnboardingScreen
      state={state}
      onboarding={onboarding}
      dispatch={(action) => actions.push(action)}
      callbacks={{}}
    />,
  );
  return { view, actions };
}

/**
 * The cloud step is the providers wizard mounted inside the onboarding
 * frame — the step machine only opens it together with a wizard state,
 * so the render mirrors that pairing.
 */
function renderCloud(wizard: ProvidersWizardState) {
  const onboarding = {
    ...createOnboardingState("http://127.0.0.1:8080"),
    step: "cloud" as const,
  };
  const state = { ...createInitialTuiState(fakeSession(), 50), onboarding };
  state.providersPanel = { ...state.providersPanel, wizard };
  return render(
    <OnboardingScreen
      state={state}
      onboarding={onboarding}
      dispatch={() => {}}
      callbacks={{}}
    />,
  );
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

  it("fits the provider list plus its search line in 24 rows, footer intact", () => {
    // ink-testing-library's stdout is not a TTY, so useTerminalSize
    // reports the 80x24 fallback — exactly the terminal the pick box
    // outgrew by one row when the always-drawn search line was added on
    // top of the fixed 12-option viewport instead of inside it.
    const view = renderCloud(createProvidersWizardState("add"));
    const lines = strip(view.lastFrame() ?? "").split("\n");
    // The search line is on screen…
    expect(lines.join("\n")).toContain("/ to search");
    // …and the whole stack still fits the 24-row terminal, so the
    // spacer-pinned footer survives as the bottom row.
    expect(lines.length).toBeLessThanOrEqual(24);
    const last = lines.filter((line) => line.trim().length > 0).at(-1) ?? "";
    expect(last).toContain("/ search");
    expect(last).toContain("ctrl+c quit");
  });

  it("advertises / search only on the wizard's list screens", () => {
    const wizard = {
      ...createProvidersWizardState("add", { kind: "openrouter" }),
      phase: "api_key" as const,
    };
    const view = renderCloud(wizard);
    const frame = strip(view.lastFrame() ?? "");
    // On the key screen `/` is just a character typed into the buffer.
    expect(frame).toContain("API key");
    expect(frame).not.toContain("/ search");
    expect(frame).toContain("ctrl+c quit");
  });

  it("moves the cursor on a keypress", async () => {
    const { view, actions } = renderFlow();
    view.stdin.write("j");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(actions).toContainEqual({ type: "onboarding_cursor_moved", delta: 1 });
  });
});
