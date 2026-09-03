import type { ResolvedLlmConfig } from "./provider-registry.js";

/**
 * KIND-based local detection, mirroring `selectComposerBackend`: any
 * `llama-server` entry is the local route, because `LlamaServerProvider`
 * accepts a custom id (`options.id`) — keying on the literal
 * `local-llama` id would leave a renamed entry ungated. An id that
 * resolves to no entry reads as local too, matching the composer's
 * no-active-row rule (and the no-`llm`-block default, which
 * `resolveLlmConfig` synthesizes as a `llama-server` entry anyway).
 *
 * The conservative direction matters: every caller uses this to decide
 * whether the local llama backend is worth probing, and an unrecognised
 * id costs one probe against a backend nobody is using — while the
 * opposite mistake runs inference on an unprobed profile.
 *
 * Not the only "is the route local?" predicate in the tree, and the two
 * are NOT equivalent: `LocalModelsOrchestrator.autoStartIfReady` asks the
 * same question by **id** (`activeTextProvider !== "local-llama"`). For a
 * `llama-server` entry under a custom id the two disagree — this one
 * calls it local, the orchestrator does not, so the managed daemon is
 * not auto-started for it. That is pre-existing and errs toward less
 * local activity (a custom-id local entry is almost always an external
 * server the operator runs themselves), so it is left alone here rather
 * than folded into this change; it is a divergence, not a shared
 * default.
 *
 * Lives beside `resolveLlmConfig` rather than under `src/tui/` because
 * `resolveLlmConfig` is a pure function of config with no I/O: the
 * answer is available at the very top of `buildRuntime`, long before a
 * `ProviderRegistry` exists. `src/tui/local-turn-gate.ts` re-exports it
 * for its original callers.
 */
export function providerIdIsLlamaServer(
  llm: ResolvedLlmConfig,
  providerId: string,
): boolean {
  const entry = llm.providers.find((p) => p.id === providerId);
  return entry === undefined || entry.kind === "llama-server";
}

/** {@link providerIdIsLlamaServer} for the active text provider. */
export function activeTextProviderIsLlamaServer(
  llm: ResolvedLlmConfig,
): boolean {
  return providerIdIsLlamaServer(llm, llm.activeTextProvider);
}
