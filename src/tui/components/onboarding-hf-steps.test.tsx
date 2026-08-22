import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";

import { OnboardingHuggingFacePickStep } from "./onboarding-hf-pick-step.js";
import { OnboardingHuggingFaceRefStep } from "./onboarding-hf-ref-step.js";
import { OnboardingLocalPickStep } from "./onboarding-local-pick-step.js";
import {
  buildLocalModelPicks,
  orderLocalModelPicks,
} from "../onboarding/local-model-picks.js";
import { computeOnboardingFit } from "../onboarding/onboarding-fit.js";
import type { OnboardingHuggingFaceRepo } from "../onboarding/onboarding-state.js";

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");
const FULL = computeOnboardingFit({ columns: 100, rows: 30 });
const GB = 1024 * 1024 * 1024;

function picks() {
  return orderLocalModelPicks(buildLocalModelPicks(16));
}

function repo(
  overrides: Partial<OnboardingHuggingFaceRepo> = {},
): OnboardingHuggingFaceRepo {
  return {
    repoId: "unsloth/Qwen3.5-4B-GGUF",
    revision: "main",
    choices: [
      {
        path: "Qwen3.5-4B-UD-Q4_K_XL.gguf",
        filename: "Qwen3.5-4B-UD-Q4_K_XL.gguf",
        sizeBytes: 2.7 * GB,
        fileSizeGb: 2.7,
        sizeLabel: "2.7 GB",
      },
      {
        path: "Qwen3.5-4B-Q8_0.gguf",
        filename: "Qwen3.5-4B-Q8_0.gguf",
        sizeBytes: 40 * GB,
        fileSizeGb: 40,
        sizeLabel: "40.0 GB",
      },
    ],
    mmproj: null,
    hidden: null,
    ...overrides,
  };
}

describe("OnboardingLocalPickStep", () => {
  it("calls the curated list a recommendation and offers the way past it", () => {
    const view = render(
      <OnboardingLocalPickStep picks={picks()} cursor={0} ramGb={16} fit={FULL} />,
    );
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("Recommended models");
    expect(frame).toContain("Add a model from Hugging Face");
    expect(frame).toContain("paste an owner/repo id");
  });

  it("keeps the Hugging Face row on screen when the list has scrolled past it", () => {
    const rows = picks();
    const view = render(
      <OnboardingLocalPickStep
        picks={rows}
        cursor={rows.length}
        ramGb={16}
        fit={FULL}
      />,
    );
    const frame = strip(view.lastFrame() ?? "");
    const hf = frame.split("\n").find((line) => line.includes("Hugging Face")) ?? "";
    expect(hf.trimStart().startsWith("›")).toBe(true);
    // The cursor is off the end of the curated rows, so none of them
    // may claim the marker as well.
    expect(frame.split("\n").filter((line) => line.includes("›"))).toHaveLength(1);
  });

  it("marks a curated row, not the Hugging Face one, while the cursor is in the list", () => {
    const view = render(
      <OnboardingLocalPickStep picks={picks()} cursor={1} ramGb={16} fit={FULL} />,
    );
    const lines = strip(view.lastFrame() ?? "").split("\n");
    const marked = lines.filter((line) => line.includes("›"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).not.toContain("Hugging Face");
  });
});

describe("OnboardingHuggingFaceRefStep", () => {
  it("asks for a reference and shows the forms it accepts", () => {
    const view = render(
      <OnboardingHuggingFaceRefStep
        value=""
        busy={false}
        error={null}
        onChange={() => {}}
        onSubmit={() => {}}
        onBack={() => {}}
      />,
    );
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("Which model?");
    expect(frame).toContain("it has to be a GGUF build");
    expect(frame).toContain("unsloth/Qwen3.5-4B-GGUF");
    expect(frame).toContain("https://huggingface.co/owner/repo");
  });

  it("prints the refusal on the screen that asked the question", () => {
    const view = render(
      <OnboardingHuggingFaceRefStep
        value="owner/repo"
        busy={false}
        error="Hugging Face returned 404: no repo or revision by that name."
        onChange={() => {}}
        onSubmit={() => {}}
        onBack={() => {}}
      />,
    );
    expect(strip(view.lastFrame() ?? "")).toContain("no repo or revision by that name");
  });

  it("says what it is waiting for while the lookup is in flight", () => {
    const view = render(
      <OnboardingHuggingFaceRefStep
        value="owner/repo"
        busy
        error={null}
        onChange={() => {}}
        onSubmit={() => {}}
        onBack={() => {}}
      />,
    );
    expect(strip(view.lastFrame() ?? "")).toContain("asking huggingface.co");
  });
});

describe("OnboardingHuggingFacePickStep", () => {
  it("names the repo and lists every servable file with its size", () => {
    const view = render(
      <OnboardingHuggingFacePickStep repo={repo()} cursor={0} ramGb={16} error={null} />,
    );
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("unsloth/Qwen3.5-4B-GGUF");
    expect(frame).toContain("Qwen3.5-4B-UD-Q4_K_XL.gguf");
    expect(frame).toContain("2.7 GB");
    expect(frame).toContain("Qwen3.5-4B-Q8_0.gguf");
  });

  it("warns about a model larger than this machine's RAM without hiding it", () => {
    const view = render(
      <OnboardingHuggingFacePickStep repo={repo()} cursor={1} ramGb={16} error={null} />,
    );
    const frame = strip(view.lastFrame() ?? "");
    expect(frame).toContain("40.0 GB model, 16 GB of RAM");
    expect(frame).toContain("run from disk");
    // Warned about, still listed, still under the cursor: nothing here
    // takes the choice away.
    expect(frame).toContain("\u203a  Qwen3.5-4B-Q8_0.gguf");
  });

  it("stays quiet about RAM when the file fits", () => {
    const view = render(
      <OnboardingHuggingFacePickStep repo={repo()} cursor={0} ramGb={16} error={null} />,
    );
    expect(strip(view.lastFrame() ?? "")).not.toContain("of RAM");
  });

  it("accounts for the files it left out", () => {
    const view = render(
      <OnboardingHuggingFacePickStep
        repo={repo({ hidden: "2 more files hidden: 1 full-precision, 1 multi-part" })}
        cursor={0}
        ramGb={16}
        error={null}
      />,
    );
    expect(strip(view.lastFrame() ?? "")).toContain("2 more files hidden");
  });

  it("shows a failed download start on the list that started it", () => {
    const view = render(
      <OnboardingHuggingFacePickStep
        repo={repo()}
        cursor={0}
        ramGb={16}
        error="EACCES: permission denied, open config.json"
      />,
    );
    expect(strip(view.lastFrame() ?? "")).toContain("permission denied");
  });
});
