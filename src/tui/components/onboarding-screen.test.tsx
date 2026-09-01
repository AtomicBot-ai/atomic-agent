import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OnboardingScreen } from "./onboarding-screen.js";
import { getConfig, resetConfigCache } from "../../config/index.js";
import { ROOT_PADDING_LEFT } from "../layout.js";
import { createOnboardingState } from "../onboarding/onboarding-state.js";
import { decideSecondBackendOffer } from "../onboarding/propose-second-backend.js";
import { createProvidersWizardState } from "../providers/providers-wizard-state.js";
import type { ProvidersWizardState } from "../providers/providers-wizard-state.js";
import { createInitialTuiState } from "../tui-state.js";
import type { TuiAction } from "../tui-action.js";
import { fakeSession } from "../test-fixtures.js";
import { renderAtSize } from "../test-sized-render.js";

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

type Step =
  | "intro"
  | "choose"
  | "local_pick"
  | "custom_chat_url"
  | "propose_second"
  | "wait_or_jump";

interface FlowOptions {
  ctrlCArmed?: boolean;
  cursor?: number;
  /** The wait-or-jump screens read the pull off the panel state. */
  panel?: { pull?: typeof PULL | null; errorLine?: string | null };
}

function flowElement(
  step: Step,
  actions: TuiAction[],
  options: FlowOptions = {},
  pullRequests: string[] = [],
) {
  const onboarding = {
    ...createOnboardingState("http://127.0.0.1:8080"),
    step,
    offer: "local" as const,
    cursor: options.cursor ?? 0,
    localModelId: step === "wait_or_jump" ? "gemma-4-e4b" : null,
  };
  const base = createInitialTuiState(fakeSession(), 50);
  const panel = options.panel;
  const state = {
    ...base,
    localModelsPanel:
      panel === undefined
        ? base.localModelsPanel
        : {
            ...base.localModelsPanel,
            pull: panel.pull === undefined ? PULL : panel.pull,
            errorLine: panel.errorLine ?? null,
          },
    onboarding,
  };
  return (
    <OnboardingScreen
      state={state}
      onboarding={onboarding}
      dispatch={(action) => actions.push(action)}
      callbacks={{
        onLocalModelsPullRequested: (modelId) => pullRequests.push(modelId),
      }}
      {...(options.ctrlCArmed === undefined
        ? {}
        : { ctrlCArmed: options.ctrlCArmed })}
    />
  );
}

function renderFlow(step: Step = "choose", options: FlowOptions = {}) {
  const actions: TuiAction[] = [];
  const pullRequests: string[] = [];
  const view = render(flowElement(step, actions, options, pullRequests));
  return { view, actions, pullRequests };
}

/** The same flow in a terminal whose stdout reports both dimensions. */
function renderFlowAt(step: Step, size: { columns: number; rows: number }) {
  const actions: TuiAction[] = [];
  const view = renderAtSize(flowElement(step, actions), size);
  return { view, actions };
}

/**
 * One size per tier, plus the exact 100×16 the review broke the block
 * at: `useTerminalSize` falls back to 80×24 when stdout carries no
 * `rows`, so every ink-testing-library frame is the reduced tier and a
 * minimal-tier defect is invisible to it by construction.
 */
const SIZES = [
  { name: "full 120×34", columns: 120, rows: 34 },
  { name: "reduced 100×24", columns: 100, rows: 24 },
  { name: "minimal 100×16", columns: 100, rows: 16 },
  { name: "minimal 60×20", columns: 60, rows: 20 },
] as const;

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

// Effects fire after commit, so a persisted side effect is awaited by
// polling config — never by trusting how fast a frame landed.
async function untilStamped(read: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!read()) {
    if (Date.now() - start > timeoutMs) throw new Error("stamp never persisted");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

  it("mirrors chat's armed Ctrl+C hint so the first press is visible", () => {
    // Same flip the chat hint strip makes: without it the first press
    // looks like a no-op, the second lands after the window disarmed,
    // and "ctrl+c quit" reads as broken during setup.
    const idle = renderFlow("intro");
    expect(strip(idle.view.lastFrame() ?? "")).toContain("ctrl+c quit");
    const armed = renderFlow("intro", { ctrlCArmed: true });
    const frame = strip(armed.view.lastFrame() ?? "");
    expect(frame).toContain("ctrl+c press again to quit");
    expect(frame).not.toContain("ctrl+c quit");
  });

  for (const size of SIZES) {
    it(`centres the block on both axes at ${size.name}, hints pinned to the last row`, () => {
      const { view } = renderFlowAt("choose", size);
      const lines = strip(view.lastFrame() ?? "").split("\n");
      view.unmount();
      // The frame is exactly the terminal: a taller one means the block
      // outgrew the measure and pushed the strip off the last row.
      expect(lines.length).toBe(size.rows);
      // "ctrl+c", not "ctrl+c quit": the surface draws the root inset
      // itself now, and at 60 columns those two cells truncate the
      // strip's tail. The pinning is what this asserts, not the copy.
      expect(lines.at(-1)).toContain("ctrl+c");
      const body = lines.slice(0, -1);
      const drawn = body
        .map((line, index) => ({ line, index }))
        .filter((row) => row.line.trim().length > 0);
      // Every tier keeps all three choices on screen.
      const frame = body.join("\n");
      expect(frame).toContain("Local models");
      expect(frame).toContain("Cloud models");
      expect(frame).toContain("Custom endpoint");
      // The block's own left edge, not the widest line's: the widest
      // line is often an option row, and its three-cell marker column is
      // part of the block rather than space around it. The surface now
      // draws the root inset itself, so the frame's leading whitespace
      // is the whole story.
      const leading = Math.min(
        ...drawn.map((row) => row.line.length - row.line.trimStart().length),
      );
      const width =
        Math.max(...drawn.map((row) => row.line.trimEnd().length)) - leading;
      const balance = (size.columns - width) / 2;
      expect(Math.abs(leading - balance)).toBeLessThanOrEqual(1);
      // One row of the gap above is the surface's own top padding, and
      // the gap below carries the last option row's bottom margin, so
      // the two halves land within a row of each other rather than dead
      // equal.
      const above = (drawn[0]?.index ?? 1) - 1;
      const below = body.length - 1 - (drawn.at(-1)?.index ?? 0);
      expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
    });
  }

  it("centres the offer screen horizontally too", () => {
    const { view } = renderFlowAt("propose_second", { columns: 120, rows: 30 });
    const lines = strip(view.lastFrame() ?? "").split("\n");
    view.unmount();
    expect(lines.at(-1)).toContain("ctrl+c quit");
    const drawn = lines.slice(0, -1).filter((line) => line.trim().length > 0);
    const leading = Math.min(
      ...drawn.map((line) => line.length - line.trimStart().length),
    );
    const width = Math.max(...drawn.map((line) => line.trimEnd().length)) - leading;
    const balance = (120 - width) / 2;
    expect(Math.abs(leading - balance)).toBeLessThanOrEqual(1);
  });

  it("keeps each minimal-tier option to one row: the measure and the render agree", () => {
    // The regression the review caught: the un-detailed rows padded out
    // to the detail column, the measure trimmed the pads, and Ink wrapped
    // the invisible cells — one blank row per option became two and the
    // block ran 50% taller than measured.
    const { view } = renderFlowAt("choose", { columns: 100, rows: 16 });
    const lines = strip(view.lastFrame() ?? "").split("\n");
    view.unmount();
    const optionRows = ["Local models", "Cloud models", "Custom endpoint"].map(
      (label) => lines.findIndex((line) => line.includes(label)),
    );
    expect(optionRows[1]).toBe((optionRows[0] ?? 0) + 2);
    expect(optionRows[2]).toBe((optionRows[1] ?? 0) + 2);
  });

  it("collapses the spacers instead of dropping options when the block barely fits", () => {
    // 10 rows leave an 8-row viewport for a 9-row block: the spacers go
    // to zero and only the block's own trailing margin is clipped. Before
    // the fix the wrapped pads pushed the third option past the viewport.
    const { view } = renderFlowAt("choose", { columns: 100, rows: 10 });
    const lines = strip(view.lastFrame() ?? "").split("\n");
    view.unmount();
    expect(lines.length).toBe(10);
    expect(lines.at(-1)).toContain("ctrl+c quit");
    const frame = lines.join("\n");
    expect(frame).toContain("Local models");
    expect(frame).toContain("Cloud models");
    expect(frame).toContain("Custom endpoint");
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

  describe("the almost-there screen", () => {
    it("draws the bar it promises and drops the row that only waits", () => {
      const { view } = renderFlow("wait_or_jump", { panel: {} });
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
      const { view, actions } = renderFlow("wait_or_jump", { panel: {} });
      view.stdin.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(actions).toContainEqual({ type: "onboarding_finished", outcome: "cloud" });
    });

    it("opens the providers wizard again on the second row", async () => {
      const { view, actions } = renderFlow("wait_or_jump", { cursor: 1, panel: {} });
      view.stdin.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(actions.map((action) => action.type)).toEqual([
        "providers_wizard_opened",
        "onboarding_cloud_meanwhile_opened",
      ]);
    });

    it("moves between the two rows", async () => {
      const { view, actions } = renderFlow("wait_or_jump", { panel: {} });
      view.stdin.write("j");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(actions).toContainEqual({
        type: "onboarding_cursor_moved",
        delta: 1,
        length: 2,
      });
    });

    it("says the local model landed once the pull is gone without an error", () => {
      const { view } = renderFlow("wait_or_jump", { panel: { pull: null } });
      const frame = strip(view.lastFrame() ?? "");
      expect(frame).toContain("local model is ready");
      expect(frame).not.toContain("Still downloading");
      expect(frame).not.toContain("starting");
      expect(frame).not.toContain("waiting");
    });

    it("offers a third row after a failed pull, and enter on it re-runs the pull", async () => {
      const { view, actions, pullRequests } = renderFlow("wait_or_jump", {
        cursor: 2,
        panel: { pull: null, errorLine: "connection reset" },
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

  describe("the download screen's skip exit", () => {
    /**
     * The finished step with the bypass flag as the skip exit leaves it:
     * outcome local, no cloud provider on disk (fresh state dir), so
     * `decideSecondBackendOffer` WOULD pitch cloud — the flag is the
     * only thing standing between the operator and a second pitch.
     * The import scan is injected so the machine the suite runs on
     * cannot decide whether the import step appears.
     */
    function renderFinished(
      skipSecondOffer: boolean,
      detected: Array<{ id: "hermes"; label: string; dir: string }> = [],
    ) {
      const actions: TuiAction[] = [];
      const onboarding = {
        ...createOnboardingState("http://127.0.0.1:8080"),
        step: "finished" as const,
        outcome: "local" as const,
        localModelId: "gemma-4-e4b",
        skipSecondOffer,
      };
      const state = { ...createInitialTuiState(fakeSession(), 50), onboarding };
      const view = render(
        <OnboardingScreen
          state={state}
          onboarding={onboarding}
          dispatch={(action) => actions.push(action)}
          callbacks={{}}
          detectImportAgents={() => detected}
        />,
      );
      return { view, actions };
    }

    it("closes straight to the agent: completed, no second pitch, no stamp", async () => {
      const { actions } = renderFinished(true);
      // Skip = completing setup with a download in flight, not
      // abandoning it — so the flow stamps completedAt, not skippedAt.
      await untilStamped(() => getConfig().tui.onboarding.completedAt !== null);
      expect(actions).toContainEqual({ type: "onboarding_set", onboarding: null });
      expect(
        actions.every((action) => action.type !== "onboarding_second_backend_offered"),
      ).toBe(true);
      // The bypass must not masquerade as "the offer was made": the
      // propose screen was never shown, so its stamp stays unset.
      expect(getConfig().tui.onboarding.proposedSecondBackendAt).toBeNull();
      expect(getConfig().tui.onboarding.skippedAt).toBeNull();
    });

    it("still raises the import step — the skip flag only bypasses the pitch", async () => {
      const { actions } = renderFinished(true, [
        { id: "hermes", label: "Hermes", dir: "/tmp/h" },
      ]);
      await untilStamped(() => getConfig().tui.onboarding.importOfferedAt !== null);
      expect(actions.map((a) => a.type)).toContain("onboarding_import_opened");
      expect(
        actions.every((action) => action.type !== "onboarding_second_backend_offered"),
      ).toBe(true);
      // Import intercepted the close-out, so the flow is not retired yet.
      expect(getConfig().tui.onboarding.completedAt).toBeNull();
    });

    it("a plain local finish still gets the cloud pitch", async () => {
      const { actions } = renderFinished(false);
      await untilStamped(
        () => getConfig().tui.onboarding.proposedSecondBackendAt !== null,
      );
      expect(actions).toContainEqual({
        type: "onboarding_second_backend_offered",
        offer: "cloud",
      });
    });
  });

  it("stamps localSetupSeenAt the moment the model list is reached", async () => {
    expect(getConfig().tui.onboarding.localSetupSeenAt).toBeNull();
    renderFlow("local_pick");
    await untilStamped(() => getConfig().tui.onboarding.localSetupSeenAt !== null);
    // The stamp is the exact input the next decision reads: with it,
    // the "set up local models too" pitch stays away for good.
    expect(
      decideSecondBackendOffer({
        outcome: "cloud",
        cloudReady: true,
        localReady: false,
        alreadyProposed: false,
        localSetupSeen: getConfig().tui.onboarding.localSetupSeenAt !== null,
      }),
    ).toBeNull();
  });

  it("leaves localSetupSeenAt null off the local branch, so the offer stands", async () => {
    renderFlow("choose");
    // Long enough for the stamping effect to have fired were it going to.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(getConfig().tui.onboarding.localSetupSeenAt).toBeNull();
    expect(
      decideSecondBackendOffer({
        outcome: "cloud",
        cloudReady: true,
        localReady: false,
        alreadyProposed: false,
        localSetupSeen: getConfig().tui.onboarding.localSetupSeenAt !== null,
      }),
    ).toBe("local");
  });
});
