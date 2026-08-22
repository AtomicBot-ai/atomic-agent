import { render } from "ink-testing-library";
import React, { useState, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  resolveHuggingFaceGgufChoices,
  type HuggingFaceRepoChoices,
} from "../../local-llm/index.js";
import { reduceTuiState } from "../agent-event-reducer.js";
import { createOnboardingState } from "../onboarding/onboarding-state.js";
import { fakeSession } from "../test-fixtures.js";
import type { TuiAction } from "../tui-action.js";
import { createInitialTuiState } from "../tui-state.js";
import { OnboardingHuggingFaceFlow } from "./onboarding-hf-flow.js";

vi.mock("../../local-llm/index.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../local-llm/index.js")>();
  return { ...original, resolveHuggingFaceGgufChoices: vi.fn() };
});

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");
const GB = 1024 * 1024 * 1024;

const CHOICES: HuggingFaceRepoChoices = {
  repoId: "unsloth/Qwen3-0.6B-GGUF",
  revision: "main",
  choices: [
    {
      path: "Qwen3-0.6B-UD-Q4_K_XL.gguf",
      filename: "Qwen3-0.6B-UD-Q4_K_XL.gguf",
      sizeBytes: 0.38 * GB,
      fileSizeGb: 0.38,
      sizeLabel: "387 MB",
    },
  ],
  mmproj: null,
  hidden: null,
};

/**
 * The flow against the real reducer, the way `OnboardingScreen` mounts
 * it — dispatched actions are both recorded and folded, so what the
 * frames show is what an operator would see.
 */
function Harness(props: { actions: TuiAction[] }): ReactElement | null {
  const [state, setState] = useState(() =>
    reduceTuiState(
      createInitialTuiState(fakeSession(), 50, {
        onboarding: createOnboardingState("http://127.0.0.1:8080"),
      }),
      { type: "onboarding_step_set", step: "local_hf_ref" },
    ),
  );
  if (!state.onboarding) return null;
  return (
    <OnboardingHuggingFaceFlow
      onboarding={state.onboarding}
      dispatch={(action) => {
        props.actions.push(action);
        setState((s) => reduceTuiState(s, action));
      }}
      ramGb={16}
    />
  );
}

/**
 * Frames land at ~4 fps and a lone esc is held back ~20 ms by Ink's
 * escape-sequence parser — assert the settled outcome, never the clock.
 */
async function until(what: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`never settled: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe("OnboardingHuggingFaceFlow", () => {
  it("esc cancels a lookup in flight and hands the editor back, reference intact", async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(resolveHuggingFaceGgufChoices).mockImplementation(
      (_ref, opts) => {
        signal = opts?.signal;
        // Never settles on its own — the 15 s Hugging Face timeout,
        // from the operator's side of the keyboard.
        return new Promise(() => {});
      },
    );
    const actions: TuiAction[] = [];
    const view = render(<Harness actions={actions} />);
    view.stdin.write("unsloth/Qwen3-0.6B-GGUF");
    await until("reference typed", () =>
      strip(view.lastFrame() ?? "").includes("unsloth/Qwen3-0.6B-GGUF"),
    );
    view.stdin.write("\r");
    await until("lookup started", () =>
      strip(view.lastFrame() ?? "").includes("asking huggingface.co"),
    );
    view.stdin.write("\u001b");
    await until("lookup cancelled", () =>
      !strip(view.lastFrame() ?? "").includes("asking huggingface.co"),
    );
    expect(signal?.aborted).toBe(true);
    // What was typed survives the cancel — the point of cancelling is
    // usually to fix it.
    expect(strip(view.lastFrame() ?? "")).toContain("unsloth/Qwen3-0.6B-GGUF");
    view.unmount();
  });

  it("drops a resolution that limps home after the cancel", async () => {
    let settle!: (repo: HuggingFaceRepoChoices) => void;
    vi.mocked(resolveHuggingFaceGgufChoices).mockImplementation(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const actions: TuiAction[] = [];
    const view = render(<Harness actions={actions} />);
    view.stdin.write("unsloth/Qwen3-0.6B-GGUF");
    view.stdin.write("\r");
    await until("lookup started", () =>
      strip(view.lastFrame() ?? "").includes("asking huggingface.co"),
    );
    view.stdin.write("\u001b");
    await until("lookup cancelled", () =>
      !strip(view.lastFrame() ?? "").includes("asking huggingface.co"),
    );
    settle(CHOICES);
    // Give a wrongly-surviving dispatch every chance to land.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(
      actions.some((action) => action.type === "onboarding_hf_repo_resolved"),
    ).toBe(false);
    expect(strip(view.lastFrame() ?? "")).toContain("Which model?");
    view.unmount();
  });

  it("still lands on the file list when the lookup wins the race", async () => {
    vi.mocked(resolveHuggingFaceGgufChoices).mockResolvedValue(CHOICES);
    const actions: TuiAction[] = [];
    const view = render(<Harness actions={actions} />);
    view.stdin.write("unsloth/Qwen3-0.6B-GGUF");
    view.stdin.write("\r");
    await until("file list shown", () =>
      strip(view.lastFrame() ?? "").includes("Qwen3-0.6B-UD-Q4_K_XL.gguf"),
    );
    expect(strip(view.lastFrame() ?? "")).toContain("387 MB");
    view.unmount();
  });
});
