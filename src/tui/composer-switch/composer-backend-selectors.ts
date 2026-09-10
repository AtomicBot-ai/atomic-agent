import type { LlmHealthStatus } from "../llm-health/llm-health-state.js";
import type { TuiState } from "../tui-state.js";
import type { ComposerBackendKind } from "./composer-switch-state.js";

/**
 * Which of the four backends the chat route is on right now.
 *
 * `fusion` is decided first and from the resolver's answer, not from the
 * provider rows: the active provider under fusion IS a cloud one, so
 * reading the rows alone would call it `cloud`. `local` and `custom` are
 * the same provider entry (`local-llama`); the config tells them apart
 * by `localModels.mode`, mirrored onto the panel as `configMode`. A
 * route with no active provider at all reads as the local one, matching
 * `selectPromptLlmMeta`.
 */
export function selectComposerBackend(state: TuiState): ComposerBackendKind {
  if (state.providersPanel.runMode?.effective === "fusion") return "fusion";
  const active =
    state.providersPanel.rows.find((row) => row.isActiveText) ?? null;
  if (active && active.kind !== "llama-server") return "cloud";
  return state.localModelsPanel.configMode === "external" ? "custom" : "local";
}

export interface ComposerBackendMeta {
  readonly kind: ComposerBackendKind;
  /**
   * The dot drawn in front of the backend word, in the vocabulary
   * `llm-health-badge.tsx` owns.
   */
  readonly status: LlmHealthStatus;
}

/**
 * What the backend control renders.
 *
 * Cloud reports `healthy` because there is no probe behind it — the
 * composer has always drawn a green dot for a cloud route, and inventing
 * an `unknown` here would read as a fault where none was observed. Local
 * and custom carry the real llama-server probe, and stay `unknown` until
 * a local backend is actually the route (`localConfigured`), so a fresh
 * install does not announce that a server nobody configured is down.
 * Fusion carries the same local probe: its cloud leg has nothing to
 * probe, and the worker daemon is the half that can actually be down.
 */
export function selectComposerBackendMeta(
  state: TuiState,
): ComposerBackendMeta {
  const kind = selectComposerBackend(state);
  if (kind === "cloud") return { kind, status: "healthy" };
  return {
    kind,
    status: state.llmHealth.localConfigured
      ? state.llmHealth.status
      : "unknown",
  };
}

/**
 * True when the route is the managed-local one and there is nothing on
 * disk to run — the state a first launch lands in after picking "local"
 * without pulling weights. The composer's model control turns into a
 * `download model` call to action in that case, because the alternative
 * it used to show was a blank slot or a catalog id for a file that does
 * not exist, and neither told the operator what to do next.
 *
 * Three deliberate abstentions:
 *
 *  - **Off the local route** — cloud has nothing to download, `custom`
 *    points at a server somebody else runs, and fusion cannot be the
 *    effective route without a downloaded model (its pre-flight refuses).
 *  - **Before the first snapshot lands** (`lastRefreshedAt === null`) —
 *    `rows` is empty until the local-models slice is refreshed, and an
 *    empty list is indistinguishable from "nothing downloaded". Saying
 *    `download model` there would flash the call to action on every
 *    boot of an install that has weights sitting on disk.
 *  - **While a pull is running** — the download the CTA asks for is
 *    already happening, and the pull's own progress is the honest
 *    readout.
 */
export function selectComposerNeedsModelDownload(state: TuiState): boolean {
  if (selectComposerBackend(state) !== "local") return false;
  const panel = state.localModelsPanel;
  if (panel.lastRefreshedAt === null) return false;
  if (panel.pull !== null) return false;
  return !panel.rows.some((row) => row.downloaded);
}
