/**
 * The serving route a session's turn ran on, remembered per session so
 * the next turn can tell the model when it changed.
 *
 * The model only learns who it is from the transcript. After a switch
 * from a text-only model to one that can see, the transcript still holds
 * the old model's "cannot read images, switch to a vision model" refusal
 * — and the new model repeats it instead of calling the tool. The route
 * is compared at turn start (`executeTurn`) and a changed one becomes a
 * one-turn `### route` note in the prompt tail
 * (`prompt/route-change-note.ts`).
 *
 * Deliberately separate from the `llm` stamp (`session-llm.ts`): that one
 * records the session's *chosen* model and the TUI / `/model` overwrite
 * it the moment the operator picks, before any turn runs — so by turn
 * start it already names the new model and cannot say what the previous
 * turn ran on. This one is written only by `executeTurn`, after the turn.
 */
import type { RunModeName } from "../config/llm-run-mode-config.js";
import { LOCAL_PROVIDER_KIND } from "../config/llm-run-mode-config.js";
import type { ResolvedRunMode } from "../llm/run-mode/resolve-run-mode.js";
import type { ResolvedLlmConfig } from "../llm/provider/registry/provider-types.js";

/** Reserved `SessionState.metadata` key the route lives under. */
export const SESSION_ROUTE_METADATA_KEY = "llmRoute";

/** One leg of a route: a configured provider and the model it serves. */
export interface RouteLeg {
  providerId: string;
  /** Model id, or `null` when the config names none. */
  model: string | null;
}

export interface SessionRoute {
  mode: RunModeName;
  /** The leg that answers the turn (fusion's orchestrator). */
  main: RouteLeg;
  /** Fusion's worker leg; `null` outside fusion. */
  worker: RouteLeg | null;
}

export interface ResolveTurnRouteInput {
  resolved: ResolvedLlmConfig;
  runMode: ResolvedRunMode;
  /** `localModels.managed.modelId` — what a local link serves. */
  managedModelId?: string | null;
  /** `RunTurnOptions.providerId`, when the turn is pinned to a link. */
  pinnedProviderId?: string;
  /**
   * The fallback chain's sticky override for this session, when an
   * earlier fallover is still in force: that link, not the configured
   * primary, is what the turn will start on.
   */
  fallbackOverrideId?: string | null;
}

/**
 * The route the turn about to run is built for. Config-derived only
 * (no `/props` alias, no profile id) so an unchanged setup always
 * resolves to the same value and a probe landing between two turns
 * cannot read as a switch.
 */
export function resolveTurnRoute(input: ResolveTurnRouteInput): SessionRoute {
  const { resolved, runMode } = input;
  const mainId =
    input.pinnedProviderId ??
    input.fallbackOverrideId ??
    resolved.activeTextProvider;
  const mode = runMode.effective;
  const main: RouteLeg = {
    providerId: mainId,
    model:
      mode === "fusion" && mainId === runMode.orchestratorProviderId
        ? runMode.orchestratorModel
        : modelOf(resolved, mainId, input.managedModelId ?? null),
  };
  const worker: RouteLeg | null =
    mode === "fusion" && runMode.workerProviderId !== null
      ? { providerId: runMode.workerProviderId, model: runMode.workerModel }
      : null;
  return { mode, main, worker };
}

function modelOf(
  resolved: ResolvedLlmConfig,
  providerId: string,
  managedModelId: string | null,
): string | null {
  const entry = resolved.providers.find((p) => p.id === providerId);
  if (entry === undefined) return null;
  if (entry.kind === LOCAL_PROVIDER_KIND) {
    return managedModelId ?? entry.model ?? null;
  }
  return entry.defaultChatModel ?? entry.model ?? null;
}

export function sameRouteLeg(
  a: RouteLeg | null,
  b: RouteLeg | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.providerId === b.providerId && a.model === b.model;
}

export function sameSessionRoute(a: SessionRoute, b: SessionRoute): boolean {
  return (
    a.mode === b.mode &&
    sameRouteLeg(a.main, b.main) &&
    sameRouteLeg(a.worker, b.worker)
  );
}

/**
 * Read the route back out of session metadata. Defensive like
 * `readSessionLlmStamp`: a malformed value is "no route", which means
 * no note, never a wrong one.
 */
export function readSessionRoute(
  metadata: Record<string, unknown> | undefined,
): SessionRoute | null {
  const raw = metadata?.[SESSION_ROUTE_METADATA_KEY];
  if (!isRecord(raw)) return null;
  const mode = raw.mode;
  if (mode !== "local" && mode !== "cloud" && mode !== "fusion") return null;
  const main = readLeg(raw.main);
  if (main === null) return null;
  const worker = raw.worker === null || raw.worker === undefined
    ? null
    : readLeg(raw.worker);
  return { mode, main, worker };
}

function readLeg(raw: unknown): RouteLeg | null {
  if (!isRecord(raw)) return null;
  const providerId = raw.providerId;
  if (typeof providerId !== "string" || providerId.length === 0) return null;
  const model = raw.model;
  return {
    providerId,
    model: typeof model === "string" && model.length > 0 ? model : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
