import {
  describeSubscriptionCliWorker,
  type SubscriptionCliWorkerNotice,
} from "../../llm/run-mode/index.js";
import type { TuiState } from "../tui-state.js";

/**
 * Why Fusion cannot be switched on right now, as the one line the
 * operator sees — or `null` when it can.
 *
 * Pure and read off the TUI's own mirrors, so the switch row's detail
 * column and the activation path agree by construction: the row that
 * says "needs a cloud provider" is the row whose Enter says the same.
 * The orchestrator re-checks from config on the way to writing it
 * (`describeRunModeDegradation`), so a stale mirror can only refuse
 * early, never write a mode that would immediately degrade.
 *
 * Abstains on the local-model check until the first snapshot lands,
 * for the reason `selectComposerNeedsModelDownload` does: an empty
 * `rows` is indistinguishable from "nothing downloaded" before then.
 */
export function describeFusionBlocker(state: TuiState): string | null {
  // Two legs, and either may be cloud or local — so the check is "are
  // there two providers that could actually answer", not "is there a
  // cloud one and a local one". A cloud row can answer when it has a
  // key; the local row can answer when something is on disk.
  const cloudReady = state.providersPanel.rows.filter(
    (row) => row.kind !== "llama-server" && row.hasApiKey,
  ).length;
  const local = state.localModelsPanel;
  // Abstains until the first snapshot lands, for the reason
  // `selectComposerNeedsModelDownload` does: an empty `rows` is
  // indistinguishable from "nothing downloaded" before then.
  const localReady =
    local.lastRefreshedAt === null || local.rows.some((row) => row.downloaded)
      ? state.providersPanel.rows.filter((row) => row.kind === "llama-server")
          .length
      : 0;
  if (cloudReady + localReady >= 2) {
    const worker = describeFusionWorkerLeg(state);
    return worker?.policy === "refuse" ? worker.short : null;
  }
  if (cloudReady + localReady === 1 && localReady === 1) {
    return "needs a second provider to orchestrate — Manage › LLM › Cloud";
  }
  if (cloudReady + localReady === 1) {
    return "needs a second provider for the workers — Manage › LLM";
  }
  return "needs two providers, one per leg — Manage › LLM";
}

/**
 * What the worker leg costs when it is a subscription CLI (ATO-1431),
 * read off the TUI's mirror of the resolved run mode — or `null` for a
 * local model, an API-key provider, or before the first refresh.
 *
 * Best-effort like the rest of this file: `RunModeOrchestrator.setMode`
 * re-resolves the leg from config and says the full sentence after the
 * switch, so a stale mirror can only mislabel the row, never skip the
 * warning.
 */
export function describeFusionWorkerLeg(
  state: TuiState,
): SubscriptionCliWorkerNotice | null {
  const workerId = state.providersPanel.runMode?.workerProviderId ?? null;
  if (workerId === null) return null;
  return describeSubscriptionCliWorker(
    state.providersPanel.rows.find((row) => row.id === workerId),
  );
}
