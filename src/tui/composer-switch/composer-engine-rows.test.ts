import { describe, expect, it } from "vitest";

import { engineRows, fusionModelRows, NETWORK_COMPUTER_LABEL, seatProviderDetail } from "./composer-engine-rows.js";
import { fusionState, providerRow } from "./composer-switch-fixtures.js";
import { selectWorkerRows } from "./composer-switch-worker-rows.js";
import type { TuiState } from "../tui-state.js";

/** The fusion fixture plus a hand-made provider for a model server on another computer. */
function withLanProvider(): TuiState {
  const base = fusionState();
  return {
    ...base,
    providersPanel: {
      ...base.providersPanel,
      rows: [
        ...base.providersPanel.rows,
        providerRow({
          id: "custom-192-168-1-20-8080",
          kind: "openai-compatible",
          hasApiKey: false,
          baseUrl: "http://192.168.1.20:8080",
        }),
      ],
    },
  };
}

describe("Fusion seat rows for a provider on another computer (ATO-1066)", () => {
  it("names a LAN server as a computer on your network, not a cloud provider", () => {
    const rows = engineRows(withLanProvider(), "orchestrator");
    expect(rows.find((row) => row.label === "custom-192-168-1-20-8080")?.detail).toBe(
      "A computer on your network",
    );
    expect(NETWORK_COMPUTER_LABEL).toBe("A computer on your network");
  });

  it("keeps the cloud label for a real cloud provider", () => {
    const rows = engineRows(withLanProvider(), "orchestrator");
    expect(rows.find((row) => row.label === "aimlapi")?.detail).toBe("No API key");
    expect(seatProviderDetail({ hasApiKey: true, baseUrl: null })).toBe("Cloud provider");
    expect(seatProviderDetail({ hasApiKey: true, baseUrl: "https://api.openai.com/v1" })).toBe(
      "Cloud provider",
    );
  });

  it("does not call this machine's own server a computer on the network", () => {
    expect(seatProviderDetail({ hasApiKey: true, baseUrl: "http://127.0.0.1:8080" })).toBe(
      "Cloud provider",
    );
  });

  it("says the same in the workers switch", () => {
    const rows = selectWorkerRows(withLanProvider());
    expect(rows.find((row) => row.label === "custom-192-168-1-20-8080")?.detail).toBe(
      "workers · on a computer on your network",
    );
    expect(rows.find((row) => row.label === "aimlapi")?.detail).toBe("no API key");
  });
});

describe("Fusion model rows for a llama.cpp server that is not ours (ATO-1563)", () => {
  function withForeignWorker(chatModel: string | null): TuiState {
    const base = fusionState({ workerProviderId: "my-llama", workerModel: "picked" });
    return {
      ...base,
      providersPanel: {
        ...base.providersPanel,
        rows: [
          ...base.providersPanel.rows,
          providerRow({ id: "my-llama", kind: "llama-server", hasApiKey: false, baseUrl: null, chatModel }),
        ],
      },
    };
  }

  it("offers one row saying what is loaded, which cannot be picked", () => {
    const rows = fusionModelRows(withForeignWorker("qwen-loaded"), "worker");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "Loaded on the server: qwen-loaded", active: true });
    expect(rows[0]!.disabled).toMatch(/Change the model on the server/);
  });

  it("says only that the server decides when it names no model", () => {
    const rows = fusionModelRows(withForeignWorker(null), "worker");
    expect(rows.map((r) => r.label)).toEqual(["Loaded on the server"]);
    expect(rows[0]!.disabled).toBeDefined();
  });
});
