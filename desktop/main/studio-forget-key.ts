/**
 * ATO-1441: removing OpenRouter in the desktop takes its key out of Core too.
 *
 * Image and video generation (the agent's tool and Studio) hand the
 * OpenRouter key to Atomic Chat Core, and Core keeps it in its own
 * `credentials.json`. The terminal forgets it there when OpenRouter is
 * removed (src/local-llm/core/core-image.ts `forgetOpenRouterMedia`, called
 * from providers-orchestrator.ts after ATO-425); the desktop removes the
 * provider with its own code (agent-cli.ts `removeProvider`), so this is the
 * same step on that path, with the same rules:
 *   - only when the removed entry was an `openrouter` one;
 *   - only when no OpenRouter key is left (studio-key.ts
 *     `pickOpenRouterKey`, the agent's `openRouterImageKey` rule);
 *   - only when Core of the app's version is installed: a missing Core
 *     holds no key, and is never downloaded for this;
 *   - best-effort: Core busy, down or refusing never fails the removal; the
 *     next key set replaces whatever Core kept anyway.
 *
 * No Electron here, so the unit tests load it from `out/`.
 */

import type { CliResult } from "./agent-cli.js";

export interface ForgetOpenRouterDeps {
  /** Core of the app's version is installed (studio-core-install.ts `isStudioCoreInstalled`). */
  installed: () => Promise<boolean>;
  /** The OpenRouter key Studio would still send to Core after the removal, or null. Never logged. */
  keyLeft: () => Promise<string | null>;
  /** `DELETE /cloud/providers/openrouter` on Core (StudioMedia.forgetOpenRouterKey). */
  forget: () => Promise<void>;
  /** A quiet line for the main process log; nothing reaches the window. */
  log?: (line: string) => void;
}

/** Take the OpenRouter key out of Core when none is left. True when Core was told; never throws. */
export async function forgetOpenRouterMedia(deps: ForgetOpenRouterDeps): Promise<boolean> {
  try {
    if (!(await deps.installed())) return false;
    if (await deps.keyLeft()) return false;
    await deps.forget();
    return true;
  } catch (err) {
    deps.log?.(`[desktop] studio: could not remove the OpenRouter key from Atomic Core (${err instanceof Error ? err.message : String(err)}); the next key set replaces it`);
    return false;
  }
}

export interface RemoveProviderForgettingDeps extends ForgetOpenRouterDeps {
  /** agent-cli.ts `removeProvider`: the result, plus the kind of the entry it took out. */
  remove: (id: string) => Promise<CliResult & { removedKind?: string }>;
  /** Where the Core step runs; it may start Core for a moment, so the removal does not wait on it. */
  background?: (work: Promise<boolean>) => void;
}

/**
 * Remove a provider entry and, when it was OpenRouter and no OpenRouter key
 * is left, forget the key in Core in the background. The removal's own
 * result is returned as it was; the Core step cannot change it.
 */
export async function removeProviderForgettingMedia(id: string, deps: RemoveProviderForgettingDeps): Promise<CliResult> {
  const { removedKind, ...result } = await deps.remove(id);
  if (result.ok && removedKind === "openrouter") {
    const work = forgetOpenRouterMedia(deps);
    (deps.background ?? ((p: Promise<boolean>) => { void p; }))(work);
  }
  return result;
}
