import { getConfig } from "../config/index.js";
import {
  getLocalModelDef,
  isKnownLocalModelId,
  isModelDownloaded,
} from "../local-llm/index.js";
import { resolveFallbackChain } from "../llm/fallback/index.js";
import { resolveLlmConfig } from "../llm/provider/registry/index.js";
import { formatBytes } from "./hooks/use-transfer-rate.js";
import type { LocalModelsPullState } from "./local-models/local-models-panel-state.js";
import type { TuiAction } from "./tui-action.js";

/**
 * Pre-turn readiness gate for the managed local backend.
 *
 * Without it a turn against a model that is not on disk burns the full
 * transport retry budget and then prints a bare `fetch failed`. The gate
 * answers ONE question just before a turn starts: "can the managed local
 * model serve this turn at all?" — and when it cannot, says which model,
 * whether it is coming down right now (live percent + bytes), and what
 * the operator actually presses to fix it.
 *
 * Scope (deliberately narrow):
 *  - managed mode only — external mode has no "on disk" notion, a dead
 *    external URL is a health problem the transport hint covers;
 *  - active text provider `local-llama` only — cloud turns never gate;
 *  - with a fallback chain of more than one configured link the gate
 *    only leaves a notice: the chain exists to save exactly this turn,
 *    so blocking it would fight the failover that would have worked;
 *  - evaluated at TURN START, not enqueue — a message parked behind a
 *    running pull may be perfectly runnable by the time it drains.
 */
export interface LocalTurnGateFacts {
  activeProviderIsLocal: boolean;
  managedMode: boolean;
  /** Configured managed model; `null` when none was ever picked. */
  modelId: string | null;
  /** GGUF on disk? Only meaningful when the gate is in scope. */
  modelDownloaded: boolean;
  /** Effective chain length from `resolveFallbackChain` (1 = no fallback). */
  fallbackChainLength: number;
}

export type LocalTurnGateDecision =
  | { kind: "run" }
  /** Chain has another link: the turn runs, this one line says why it may fail over. */
  | { kind: "notice"; text: string }
  /** No fallback link to save the turn: refuse it with the fix. */
  | { kind: "block"; text: string };

/**
 * Read the live facts from config + disk. Cheap on the happy path: the
 * disk stat runs only for a managed local provider, and the fallback
 * chain is resolved only once the model is already known to be missing.
 */
export function readLocalTurnGateFacts(): LocalTurnGateFacts {
  const cfg = getConfig();
  const active = cfg.llm?.activeTextProvider;
  // No llm block resolves to the default `local-llama` primary.
  const activeProviderIsLocal = !active || active === "local-llama";
  const managedMode = cfg.localModels.mode === "managed";
  const inScope = activeProviderIsLocal && managedMode;
  const modelId = cfg.localModels.managed.modelId;
  const modelDownloaded =
    !inScope ||
    (modelId !== null &&
      isKnownLocalModelId(modelId) &&
      isModelDownloaded(cfg.paths.localModelsDataDir, getLocalModelDef(modelId)));
  return {
    activeProviderIsLocal,
    managedMode,
    modelId,
    modelDownloaded,
    fallbackChainLength:
      inScope && !modelDownloaded
        ? resolveFallbackChain(resolveLlmConfig(cfg)).chain.length
        : 1,
  };
}

/**
 * Live progress line for a pull that is bringing `modelId` closer to
 * serving: the model's own GGUF/mmproj pull, or the backend pull that
 * must finish before any model can. `null` when nothing relevant is in
 * flight (including a pull for a *different* model — saying
 * "downloading now" about someone else's download would promise a model
 * that is not coming).
 */
export function downloadProgressFor(
  pull: LocalModelsPullState | null,
  modelId: string,
): string | null {
  if (!pull || pull.error !== null) return null;
  if (pull.kind === "embedding") return null;
  if (pull.kind === "chat" && pull.modelId !== modelId) return null;
  // Mirrors `downloadingLabel`'s guard: before content-length arrives
  // there is no honest percent or total to print.
  if (pull.totalBytes <= 0) return "downloading now…";
  return `downloading now — ${pull.percent}% · ${formatBytes(pull.transferredBytes)} / ${formatBytes(pull.totalBytes)}`;
}

export function evaluateLocalTurnGate(
  facts: LocalTurnGateFacts,
  pull: LocalModelsPullState | null,
): LocalTurnGateDecision {
  if (!facts.activeProviderIsLocal || !facts.managedMode) return { kind: "run" };
  if (facts.modelId !== null && facts.modelDownloaded) return { kind: "run" };
  const status =
    facts.modelId === null
      ? "no local model is selected — open Models (/local) to pick and download one"
      : (downloadProgressFor(pull, facts.modelId) ??
        "not downloaded — open Models (/local) and press Enter on it to download");
  const subject =
    facts.modelId === null ? status : `local model ${facts.modelId} is ${status}`;
  if (facts.fallbackChainLength > 1) {
    return {
      kind: "notice",
      text: `${subject} — running this turn through the fallback chain`,
    };
  }
  return { kind: "block", text: subject };
}

/**
 * Mirror of the reducer's non-embedding pull slot
 * (`state.localModelsPanel.pull`), for code that lives outside the React
 * tree. Orchestrators cannot read reducer state, and the pull events are
 * emitted from half a dozen sites — tapping the bus once catches them
 * all without threading progress callbacks through each one.
 */
export function reduceChatPull(
  current: LocalModelsPullState | null,
  action: TuiAction,
): LocalModelsPullState | null {
  switch (action.type) {
    case "local_models_pull_started":
      return action.pull.kind === "embedding" ? current : action.pull;
    case "local_models_pull_progress":
      if (action.kind === "embedding" || current === null) return current;
      return {
        ...current,
        percent: action.percent,
        transferredBytes: action.transferredBytes,
        totalBytes: action.totalBytes,
      };
    case "local_models_pull_finished":
    case "local_models_pull_failed":
      // A failed pull is not "in flight" — the gate must fall back to
      // the not-downloaded wording, not report a dead download forever.
      return action.kind === "embedding" ? current : null;
    default:
      return current;
  }
}

/** Bus-fed holder around {@link reduceChatPull} for orchestrator fields. */
export class ChatPullMirror {
  private pull: LocalModelsPullState | null = null;

  attach(bus: { subscribe(listener: (action: TuiAction) => void): () => void }): void {
    bus.subscribe((action) => {
      this.pull = reduceChatPull(this.pull, action);
    });
  }

  get current(): LocalModelsPullState | null {
    return this.pull;
  }
}
