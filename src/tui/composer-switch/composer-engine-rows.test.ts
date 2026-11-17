import { describe, expect, it } from "vitest";

import { engineRows, NETWORK_COMPUTER_LABEL, seatProviderDetail } from "./composer-engine-rows.js";
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
