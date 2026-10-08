import type { TuiState } from "../tui-state.js";
import type { ComposerSwitchRow } from "./composer-switch-row-contracts.js";
import { selectCloudModelSection } from "../llm-panel/llm-panel-row-builders.js";

export function localEngineLabel(state: TuiState): string {
  return state.localModelsPanel.backend.engine === "atomic-core" ? "Atomic Chat" : "Local llama";
}
export function engineRows(state: TuiState, leg?: "orchestrator" | "worker"): readonly ComposerSwitchRow[] {
  const rm = state.providersPanel.runMode;
  const selected = leg === "worker" ? rm?.workerProviderId : rm?.orchestratorProviderId;
  const other = leg === "worker" ? rm?.orchestratorProviderId : rm?.workerProviderId;
  const cloud: ComposerSwitchRow[] = leg ? state.providersPanel.rows.filter(p => p.kind !== "llama-server" && p.id !== other).map(p => ({
    id: `engine:${leg}:${p.id}`, label: p.id, detail: p.hasApiKey ? "Cloud provider" : "No API key",
    active: selected === p.id, intent: { kind: "fusionLeg", leg, providerId: p.id },
  })) : [];
  const local: ComposerSwitchRow[] = leg && other === "local-llama" ? [] : (["llama-server", "atomic-core"] as const).map(engine => ({
    id: `engine:${leg ?? "local"}:${engine}`, label: engine === "atomic-core" ? "Atomic Chat" : "Local llama",
    detail: engine === "atomic-core" ? "Atomic Chat Core on this machine" : "llama.cpp on this machine",
    active: (!leg || selected === "local-llama") && (state.localModelsPanel.backend.engine ?? "llama-server") === engine,
    intent: { kind: "localEngine", engine, ...(leg ? { leg } : {}) },
  }));
  return [...cloud, ...local, ...(leg ? [{id: "engine:add", label: "Add a new provider", detail: "opens the wizard", active: false, intent: {kind: "addProvider" as const}}] : [])];
}
export function fusionModelRows(state: TuiState, leg: "orchestrator" | "worker"): readonly ComposerSwitchRow[] {
  const rm = state.providersPanel.runMode;
  const id = leg === "worker" ? rm?.workerProviderId : rm?.orchestratorProviderId;
  const chosen = leg === "worker" ? rm?.workerModel : rm?.orchestratorModel;
  if (id === "local-llama") return [
    ...state.localModelsPanel.rows.filter(m => m.downloaded).map(m => ({
      id: `model:${leg}:${m.id}`, label: m.id, detail: "On this machine", active: m.id === (chosen ?? state.localModelsPanel.activeModelId),
      intent: {kind: "fusionModel" as const, leg, modelId: m.id},
    })),
    {id: "model:download", label: "Download more models…", detail: "opens the local models pane", active: false, intent: {kind: "localModelsPanel"}},
  ];
  // Reuse the provider catalog selector, with this role as the read-only focus.
  const focused = {...state, providersPanel: {...state.providersPanel, rows: state.providersPanel.rows.map(p => ({...p, isActiveText: p.id === id}))}};
  const section = selectCloudModelSection(focused);
  if (!section.provider || section.provider.id !== id) return [];
  return section.models.map(modelId => ({id: `model:${leg}:${modelId}`, label: modelId,
    detail: section.status === "loading" ? "Loading…" : "", active: modelId === (chosen ?? section.provider?.chatModel),
    intent: {kind: "fusionModel", leg, modelId}}));
}
