import { LOCAL_PROVIDER_KIND } from "../../config/llm-run-mode-config.js";
import type { LocalLegRole } from "../../local-llm/worker-slots.js";
import type { ResolvedLlmConfig } from "../provider/registry/provider-types.js";
import type { ResolvedRunMode } from "./resolve-run-mode.js";

/**
 * Which half of a fusion pairing the managed llama-server is serving.
 *
 * `resolveRunMode` deliberately honours a pinned leg whatever its kind,
 * so fusion runs in two directions: cloud orchestrator with local
 * workers (the usual one), or a local orchestrator with the workers in
 * the cloud. The daemon's `--parallel` wants the opposite thing in each
 * — more slots for a fan-out, exactly one for a single orchestrating
 * stream (see `worker-slots.ts` for the measured numbers) — and this is
 * the only place that can tell them apart, because the kinds live on the
 * resolved provider entries rather than on `ResolvedRunMode`.
 *
 * Read the legs, never guess them. The local leg orchestrates only when
 * the *orchestrator* entry is the llama-server and the *worker* entry is
 * not; every other shape — both cloud, both local, a leg that did not
 * resolve — is the historical `"workers"`, as is any mode but fusion.
 * `local` and `cloud` have one leg between them and no direction to
 * choose, so they keep today's launch exactly.
 *
 * Lives here rather than in `src/local-llm/**` because that layer may
 * not import `src/llm/**` (the dependency runs the other way, e.g.
 * `model-profile-manager.ts`), so the role is resolved by the callers
 * that build `DaemonStartOptions` and passed down as data.
 */
export function resolveLocalLegRole(
  resolved: ResolvedLlmConfig,
  runMode: ResolvedRunMode,
): LocalLegRole {
  if (runMode.effective !== "fusion") return "workers";
  const kindOf = (id: string | null): string | undefined =>
    id === null ? undefined : resolved.providers.find((p) => p.id === id)?.kind;
  const orchestratorKind = kindOf(runMode.orchestratorProviderId);
  const workerKind = kindOf(runMode.workerProviderId);
  return orchestratorKind === LOCAL_PROVIDER_KIND &&
    workerKind !== undefined &&
    workerKind !== LOCAL_PROVIDER_KIND
    ? "orchestrator"
    : "workers";
}
