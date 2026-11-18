import { resolveStateDir } from "../config/load-config.js";
import { EMPTY_POLICY, type EffectivePolicy } from "./policy-evaluator.js";
import { loadLocalPolicy } from "./policy-loader.js";

let active: EffectivePolicy | null = null;

/**
 * Set by the runtime at boot, after `loadPolicy` fetched the URL. The same
 * install / read pair as `installToolHooks`: the skill installer and the
 * dispatcher read it per call instead of having it threaded through.
 * `null` forgets it, so the next read loads the local copy again.
 */
export function installPolicy(policy: EffectivePolicy | null): void {
  active = policy;
}

/**
 * The installed policy, or (in a short-lived command that never booted a
 * runtime) the local files plus the cached URL copy, read once. Never
 * throws: a policy that cannot be read is no policy.
 */
export function activePolicy(): EffectivePolicy {
  if (active !== null) return active;
  try {
    active = loadLocalPolicy({ stateDir: resolveStateDir() });
  } catch {
    active = EMPTY_POLICY;
  }
  return active;
}
