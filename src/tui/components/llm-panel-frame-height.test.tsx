import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { LOCAL_MODELS_CATALOG } from "../../local-llm/index.js";
import { extractLoadFailure } from "../../local-llm/daemon-lifecycle.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import { LlmPanel } from "./llm-panel.js";

/**
 * Ink overlaps lines when a frame is taller than its budget — it does not
 * clip — so a panel that overruns `maxRows` renders as visible garbage.
 * These are regression tests for frames that used to overrun.
 */
function frameHeight(node: Parameters<typeof render>[0]): number {
  return (render(node).lastFrame() ?? "").split("\n").length;
}

/** A real `llama-server` failure: one sentence plus a 4KB log tail. */
const MULTILINE_DAEMON_ERROR = [
  "llama-server did not become healthy within 30000ms. Log tail:",
  ...Array.from(
    { length: 24 },
    (_, i) => `0.00.${i} E llama_model_load: error loading model: unknown model architecture: 'nanbeige'`,
  ),
].join("\n");

function baseState(over: Partial<TuiState["localModelsPanel"]> = {}): TuiState {
  const base = createInitialTuiState(fakeSession());
  return {
    ...base,
    uiMode: "debug",
    activeTab: "llm",
    llmPanel: { ...base.llmPanel, mode: "local" },
    localModelsPanel: {
      ...base.localModelsPanel,
      totalRamGb: 64,
      rows: LOCAL_MODELS_CATALOG.map((def) => ({
        id: def.id,
        def,
        downloaded: false,
        active: false,
        mmprojStatus: "missing" as const,
      })),
      ...over,
    },
  };
}

describe("LlmPanel frame height", () => {
  const MAX = 24;

  it("stays within budget with a multi-line daemon error", () => {
    expect(
      frameHeight(
        <LlmPanel state={baseState({ daemonError: MULTILINE_DAEMON_ERROR })} maxRows={MAX} />,
      ),
    ).toBeLessThanOrEqual(MAX);
  });

  it("stays within budget with a multi-line catalog error", () => {
    expect(
      frameHeight(
        <LlmPanel state={baseState({ errorLine: MULTILINE_DAEMON_ERROR })} maxRows={MAX} />,
      ),
    ).toBeLessThanOrEqual(MAX);
  });

  it("stays within budget while the Hugging Face prompt is open", () => {
    const base = baseState();
    const state: TuiState = {
      ...base,
      llmPanel: {
        ...base.llmPanel,
        huggingFacePrompt: {
          buffer: "qwen3 coder",
          busy: false,
          error: null,
          results: Array.from({ length: 9 }, (_, i) => ({
            repoId: `owner/Repo-${i}-GGUF`,
            downloads: 1000 - i,
          })),
        },
      },
    };
    expect(frameHeight(<LlmPanel state={state} maxRows={MAX} />)).toBeLessThanOrEqual(
      MAX,
    );
  });

  it("stays within budget with the prompt open AND a daemon error", () => {
    const base = baseState({ daemonError: MULTILINE_DAEMON_ERROR });
    const state: TuiState = {
      ...base,
      llmPanel: {
        ...base.llmPanel,
        huggingFacePrompt: {
          buffer: "qwen3 coder",
          busy: false,
          error: null,
          results: Array.from({ length: 9 }, (_, i) => ({
            repoId: `owner/Repo-${i}-GGUF`,
            downloads: 1000 - i,
          })),
        },
      },
    };
    expect(frameHeight(<LlmPanel state={state} maxRows={MAX} />)).toBeLessThanOrEqual(
      MAX,
    );
  });

  it("stays within budget with active download banners", () => {
    const pull = (kind: "chat" | "embedding", id: string) => ({
      kind,
      modelId: id as never,
      label: id,
      percent: 40,
      transferredBytes: 1,
      totalBytes: 2,
      error: null,
    });
    // The banner group emits one shared bottom margin on top of three
    // rows per banner — an easy row to forget in the estimate.
    expect(
      frameHeight(
        <LlmPanel state={baseState({ pull: pull("chat", "qwen-3.5-4b") })} maxRows={MAX} />,
      ),
    ).toBeLessThanOrEqual(MAX);
    expect(
      frameHeight(
        <LlmPanel
          state={baseState({
            pull: pull("chat", "qwen-3.5-4b"),
            embeddingPull: pull("embedding", "bge-m3"),
          })}
          maxRows={MAX}
        />,
      ),
    ).toBeLessThanOrEqual(MAX);
  });

  it("stays within budget while the daemon is starting", () => {
    expect(
      frameHeight(<LlmPanel state={baseState({ daemonPhase: "starting" })} maxRows={MAX} />),
    ).toBeLessThanOrEqual(MAX);
  });

  it("still shows the first line of the error, and points at the log tab", () => {
    const frame =
      render(
        <LlmPanel state={baseState({ daemonError: MULTILINE_DAEMON_ERROR })} maxRows={MAX} />,
      ).lastFrame() ?? "";
    expect(frame).toContain("did not become healthy within 30000ms");
    expect(frame).not.toContain("unknown model architecture");
  });
});

describe("extractLoadFailure", () => {
  it("names the architecture the build cannot read", () => {
    expect(
      extractLoadFailure(
        "0.00.195 E llama_model_load: error loading model: unknown model architecture: 'nanbeige'\n" +
          "0.00.195 E llama_model_load_from_file_impl: failed to load model\n",
      ),
    ).toBe("unknown model architecture: 'nanbeige'");
  });

  it("falls back through less specific lines, then to null", () => {
    expect(extractLoadFailure("E error loading model: bad magic")).toBe(
      "error loading model: bad magic",
    );
    expect(extractLoadFailure("srv failed to load model, '/x/y.gguf'")).toContain(
      "failed to load model",
    );
    expect(extractLoadFailure("nothing interesting here")).toBeNull();
  });
});
