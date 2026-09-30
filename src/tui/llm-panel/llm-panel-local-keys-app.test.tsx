import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { LocalModelDef, LocalModelId } from "../../local-llm/index.js";
import type { LocalModelRow } from "../local-models/local-models-panel-state.js";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "../tui-app.js";
import { fakeSession } from "../test-fixtures.js";

/**
 * #546: the local-model keys (`d`, `g`, `i`, `G`, `U`, `x`) lived only
 * on the Models tab, and every route to that tab lands on the LLM tab's
 * Local pane instead. Rendered through real Ink with real stdin, so the
 * keys travel the same path an operator's do: `handleAppKey`, then the
 * panel router, then the LLM tab's key layer.
 */

const ESC = String.fromCharCode(27);
/** Past Ink's 20ms lone-Esc flush window. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

const strip = (value: string): string =>
  value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\]8;;[^\u0007]*\u0007/g, "");

function def(id: LocalModelId, description: string): LocalModelDef {
  return {
    id,
    name: id,
    filename: `${id}.gguf`,
    huggingFaceUrl: "u",
    fileSizeGb: 1,
    sizeLabel: "1 GB",
    description,
    maxContextLength: 8192,
    contextLabel: "8K",
    minRamGb: 1,
    recommendedRamGb: 2,
    family: "qwen",
    supportsVision: false,
  } as LocalModelDef;
}

const ROWS: LocalModelRow[] = [
  {
    id: "custom-on-disk",
    def: def("custom-on-disk", "Weights already on this machine."),
    downloaded: true,
    mmprojStatus: "n/a",
    active: false,
  },
  {
    id: "custom-remote",
    def: def("custom-remote", "Not fetched yet."),
    downloaded: false,
    mmprojStatus: "n/a",
    active: false,
  },
];

async function openLocalPane(overrides: Partial<TuiAppCallbacks>) {
  const callbacks: TuiAppCallbacks = {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {},
    onMessageSubmitted: () => {},
    ...overrides,
  };
  const bus = makeTuiEventBus();
  const rendered = render(
    <TuiApp session={fakeSession()} bus={bus} callbacks={callbacks} />,
  );
  await settle();
  bus.emit({ type: "ui_mode_set", mode: "debug" });
  // The route the Models tab's own entry points take.
  bus.emit({ type: "tab_changed", tab: "models" });
  bus.emit({
    type: "local_models_snapshot_loaded",
    rows: ROWS,
    backend: { currentTag: "v1", latestTag: "v1", updateAvailable: false },
    daemon: {
      running: false,
      healthy: false,
      loading: false,
      pid: null,
      port: 19091,
    },
    configMode: "managed",
    activeModelId: null,
    totalRamGb: 32,
    gpuBudgetGb: null,
    dataDir: "/tmp/data",
    at: 1,
    embeddingRows: [],
    embeddingDaemon: {
      enabled: false,
      running: false,
      healthy: false,
      loading: false,
      pid: null,
      port: 19092,
      activeModelId: null,
    },
  });
  await settle();
  return { ...rendered, bus };
}

const frameOf = (lastFrame: () => string | undefined): string =>
  strip(lastFrame() ?? "");

describe("LLM tab Local pane: model keys (#546)", () => {
  it("d opens the delete confirm for the downloaded row and y deletes it", async () => {
    const onRemove = vi.fn();
    const { lastFrame, stdin, unmount } = await openLocalPane({
      onLocalModelsRemoveConfirmed: onRemove,
    });
    expect(frameOf(lastFrame)).toContain("Local text models");

    stdin.write("d");
    await settle();
    expect(frameOf(lastFrame)).toContain("Delete local model custom-on-disk?");

    stdin.write("y");
    await settle();
    expect(onRemove).toHaveBeenCalledWith("custom-on-disk");
    expect(frameOf(lastFrame)).not.toContain("Delete local model");
    unmount();
  });

  it("g pulls the GGUF alone, and only for a row that is not on disk", async () => {
    const onPull = vi.fn();
    const { stdin, unmount } = await openLocalPane({
      onLocalModelsPullRequested: onPull,
    });

    stdin.write("g");
    await settle();
    expect(onPull).not.toHaveBeenCalled();

    stdin.write("j");
    await settle();
    stdin.write("g");
    await settle();
    expect(onPull).toHaveBeenCalledWith("custom-remote", "gguf-only");
    unmount();
  });

  it("G cycles the GPU device and U toggles backend auto-update", async () => {
    const onDevice = vi.fn();
    const onAutoUpdate = vi.fn();
    const { stdin, unmount } = await openLocalPane({
      onLocalModelsDeviceCycleRequested: onDevice,
      onLocalModelsAutoUpdateToggleRequested: onAutoUpdate,
    });

    stdin.write("G");
    await settle();
    stdin.write("U");
    await settle();
    expect(onDevice).toHaveBeenCalledTimes(1);
    expect(onAutoUpdate).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("i opens the model detail and Esc returns to the list, not to chat", async () => {
    const { lastFrame, stdin, unmount } = await openLocalPane({});

    stdin.write("i");
    await settle();
    let frame = frameOf(lastFrame);
    expect(frame).toContain("Weights already on this machine.");
    expect(frame).toContain("Esc back");
    expect(frame).not.toContain("Local text models");

    stdin.write(ESC);
    await settle();
    frame = frameOf(lastFrame);
    expect(frame).toContain("Local text models");
    expect(frame).not.toContain("Weights already on this machine.");
    unmount();
  });

  it("x stops the download in flight", async () => {
    const onCancel = vi.fn();
    const { stdin, bus, unmount } = await openLocalPane({
      onLocalModelsPullCancelRequested: onCancel,
    });
    bus.emit({
      type: "local_models_pull_started",
      pull: {
        kind: "chat",
        modelId: "custom-remote",
        label: "custom-remote",
        percent: 10,
        transferredBytes: 100,
        totalBytes: 1000,
        error: null,
      },
    });
    await settle();

    stdin.write("x");
    await settle();
    expect(onCancel).toHaveBeenCalledWith("chat");
    unmount();
  });
});
