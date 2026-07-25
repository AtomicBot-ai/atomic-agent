import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { LOCAL_MODELS_CATALOG } from "../../local-llm/index.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import { LlmPanel } from "./llm-panel.js";

function stateWithCatalog(overrides: Partial<TuiState["llmPanel"]> = {}): TuiState {
  const base = createInitialTuiState(fakeSession());
  return {
    ...base,
    uiMode: "debug",
    activeTab: "llm",
    llmPanel: { ...base.llmPanel, mode: "local", ...overrides },
    localModelsPanel: {
      ...base.localModelsPanel,
      totalRamGb: 64,
      rows: LOCAL_MODELS_CATALOG.slice(0, 2).map((def) => ({
        id: def.id,
        def,
        downloaded: false,
        active: false,
        mmprojStatus: "missing" as const,
      })),
    },
  };
}

describe("LlmPanel — Hugging Face affordance", () => {
  it("renders the add row as the last entry under Local text models", () => {
    const { lastFrame } = render(<LlmPanel state={stateWithCatalog()} maxRows={30} />);
    const lines = (lastFrame() ?? "").split("\n").map((l) => l.trim());
    const addIdx = lines.findIndex((l) => l.includes("Add a model from Hugging Face"));
    const headerIdx = lines.findIndex((l) => l.includes("Local text models"));
    const embeddingIdx = lines.findIndex((l) => l.includes("Local embeddings"));

    expect(addIdx).toBeGreaterThan(headerIdx);
    expect(addIdx).toBeLessThan(embeddingIdx);
    expect(lines[addIdx]).toContain("Enter: paste a URL or search");
    // Directly under the last model, not floated to the section top.
    expect(lines[addIdx - 1]).toContain(LOCAL_MODELS_CATALOG[1]!.id);
  });

  it("renders the prompt with a search result pick list", () => {
    const { lastFrame } = render(
      <LlmPanel
        state={stateWithCatalog({
          huggingFacePrompt: {
            buffer: "qwen3 coder",
            busy: false,
            error: null,
            results: [
              { repoId: "unsloth/Qwen3-Coder-30B-GGUF", downloads: 389410 },
              { repoId: "Qwen/Qwen3-4B-GGUF", downloads: 291907 },
            ],
          },
        })}
        maxRows={30}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Add a model from Hugging Face");
    expect(frame).toContain("qwen3 coder");
    expect(frame).toContain("press a number to add");
    expect(frame).toContain("1 unsloth/Qwen3-Coder-30B-GGUF");
    expect(frame).toContain("2 Qwen/Qwen3-4B-GGUF");
    expect(frame).toContain("Enter submit");
  });

  it("surfaces a resolution error inside the prompt", () => {
    const { lastFrame } = render(
      <LlmPanel
        state={stateWithCatalog({
          huggingFacePrompt: {
            buffer: "Qwen/Qwen3-8B",
            busy: false,
            error: "no .gguf files in huggingface.co/Qwen/Qwen3-8B @ main",
            results: [],
          },
        })}
        maxRows={30}
      />,
    );
    const frame = lastFrame() ?? "";
    // The typed text survives the error so it can be corrected in place.
    expect(frame).toContain("Qwen/Qwen3-8B");
    expect(frame).toContain("no .gguf files");
  });
});
