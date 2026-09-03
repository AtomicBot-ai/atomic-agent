import type { ResolvedLlmConfig } from "../llm/provider/registry/index.js";
import type { SessionLlmStamp } from "../session/session-llm.js";

/**
 * What switching into a session should do about the active model.
 *
 * Pure decision, separated from the orchestrator so the interesting
 * cases (no stamp, provider deleted since, already active, model-less
 * provider) are unit-testable without a bus or a config file. The
 * orchestrator translates the plan into the same actions the LLM panel
 * emits — `providers_select_chat_model` / `providers_set_active_text` —
 * so restoring goes through the one code path that already knows how to
 * persist the config and reload the provider.
 */
export type ModelRestorePlan =
  /** Nothing to do: no stamp, or the stamp is already the active model. */
  | { kind: "none" }
  /** The stamped provider is gone from the config; say so, change nothing. */
  | { kind: "missing"; providerId: string; chatModel: string | null }
  /** Re-apply provider + chat model (the LLM panel's select-model path). */
  | { kind: "select"; providerId: string; modelId: string }
  /**
   * Re-apply the provider alone — the stamp names no model (e.g. a bare
   * llama-server entry), so only the active-provider switch applies.
   */
  | { kind: "activate"; providerId: string };

export function planModelRestore(
  stamp: SessionLlmStamp | null,
  resolved: ResolvedLlmConfig,
): ModelRestorePlan {
  if (!stamp) return { kind: "none" };
  const entry = resolved.providers.find((p) => p.id === stamp.providerId);
  if (!entry) {
    return {
      kind: "missing",
      providerId: stamp.providerId,
      chatModel: stamp.chatModel,
    };
  }
  const activeEntry = resolved.providers.find(
    (p) => p.id === resolved.activeTextProvider,
  );
  const activeModel =
    activeEntry?.defaultChatModel ?? activeEntry?.model ?? null;
  const sameProvider = stamp.providerId === resolved.activeTextProvider;
  if (stamp.chatModel === null) {
    // A model-less stamp asks only for the provider. When it is already
    // active, whatever model it currently serves is as close to "what
    // the session ran on" as the stamp can say.
    return sameProvider
      ? { kind: "none" }
      : { kind: "activate", providerId: stamp.providerId };
  }
  if (sameProvider && stamp.chatModel === activeModel) return { kind: "none" };
  return {
    kind: "select",
    providerId: stamp.providerId,
    modelId: stamp.chatModel,
  };
}

/** One line for the transcript describing what a plan is about to do. */
export function describeModelRestore(plan: ModelRestorePlan): string | null {
  switch (plan.kind) {
    case "none":
      return null;
    case "missing":
      return `this session last ran on "${plan.providerId}${
        plan.chatModel ? `/${plan.chatModel}` : ""
      }", which is no longer configured — keeping the current model`;
    case "select":
      return `restoring this session's model: ${plan.providerId}/${plan.modelId}`;
    case "activate":
      return `restoring this session's provider: ${plan.providerId}`;
  }
}
