import { hostOfUrl, isLoopbackHost } from "../../llm/offline-network.js";
import type { ProviderRow } from "../providers/providers-panel-state.js";
import type { TuiState } from "../tui-state.js";
import {
  configuredCloudProviders,
  type ComposerSwitchRow,
} from "./composer-switch-row-contracts.js";

/**
 * Offline mode in the composer's switches (ATO-1088).
 *
 * While the network kill switch (ATO-1084, `network.offline`) is on, a
 * cloud provider cannot answer: the HTTP pool refuses its host. Rows
 * that would route the chat through the internet stay in the list, so
 * the operator still sees what exists, but they are greyed out with one
 * plain reason and Enter on them does nothing but say it. Local rows
 * behave as usual.
 *
 * Pure: the caller passes whether offline mode is on.
 */
export const OFFLINE_ROW_REASON = "Offline mode is on";

/** True when `url` points at this machine (the only hosts offline allows). */
function isLocalUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const host = hostOfUrl(url);
  return host !== null && isLoopbackHost(host);
}

/**
 * Does this provider answer from this machine? The managed llama.cpp
 * does, and so does an OpenAI-compatible entry whose base URL is
 * loopback (LM Studio, Ollama). Everything else, subscription CLIs
 * included, needs the internet.
 */
export function providerRunsOnThisMachine(
  provider: Pick<ProviderRow, "kind" | "baseUrl" | "subscriptionCli">,
): boolean {
  if (provider.kind === "llama-server") return true;
  if (provider.subscriptionCli) return false;
  return isLocalUrl(provider.baseUrl);
}

function providerIdRunsHere(state: TuiState, id: string | null | undefined): boolean {
  if (!id) return false;
  if (id === "local-llama") return true;
  const provider = state.providersPanel.rows.find((row) => row.id === id);
  return provider ? providerRunsOnThisMachine(provider) : false;
}

/** Would choosing this row send the chat over the internet? */
export function rowNeedsInternet(row: ComposerSwitchRow, state: TuiState): boolean {
  const intent = row.intent;
  switch (intent.kind) {
    case "backend": {
      if (intent.backend === "local") return false;
      if (intent.backend === "custom") return !isLocalUrl(state.session.llamaUrl);
      if (intent.backend === "cloud") {
        return !configuredCloudProviders(state).some(providerRunsOnThisMachine);
      }
      const runMode = state.providersPanel.runMode;
      return !(
        providerIdRunsHere(state, runMode?.orchestratorProviderId) &&
        providerIdRunsHere(state, runMode?.workerProviderId)
      );
    }
    case "llmRow": {
      const llmRow = intent.row;
      if (
        llmRow.kind === "cloudProvider" ||
        llmRow.kind === "cloudChatModel" ||
        llmRow.kind === "cloudEmbeddingModel"
      ) {
        return !providerRunsOnThisMachine(llmRow.provider);
      }
      if (llmRow.kind === "externalUrl") return !isLocalUrl(llmRow.url);
      return false;
    }
    case "fusionLeg":
      return !providerIdRunsHere(state, intent.providerId);
    case "fusionModel": {
      const runMode = state.providersPanel.runMode;
      const id =
        intent.leg === "worker"
          ? runMode?.workerProviderId
          : runMode?.orchestratorProviderId;
      return !providerIdRunsHere(state, id);
    }
    default:
      return false;
  }
}

/**
 * The rows as offline mode shows them: unchanged while it is off;
 * while it is on, every row that needs the internet is disabled with
 * `OFFLINE_ROW_REASON` as both its detail and its refusal.
 */
export function gateRowsForOffline(
  rows: readonly ComposerSwitchRow[],
  state: TuiState,
  offline: boolean,
): readonly ComposerSwitchRow[] {
  if (!offline) return rows;
  return rows.map((row) =>
    rowNeedsInternet(row, state)
      ? { ...row, detail: OFFLINE_ROW_REASON, disabled: OFFLINE_ROW_REASON }
      : row,
  );
}
