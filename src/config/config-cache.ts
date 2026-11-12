import { AsyncLocalStorage } from "node:async_hooks";

import { loadConfig } from "./load-config.js";
import type { AtomicAgentConfig } from "./config-schema.js";

let cachedConfig: AtomicAgentConfig | null = null;

/**
 * ATO-1213: a config read fresh from disk for one piece of work, without
 * touching the process-wide cache below. `atag serve` keeps the config it
 * booted with for its own runtime, but its read-only `GET /api/local-models/*`
 * answers must describe the machine as it is now: after `atag models use X`
 * on that machine, the desktop connected to it kept showing the old model
 * ACTIVE until serve restarted.
 */
const freshScope = new AsyncLocalStorage<AtomicAgentConfig>();

export function getConfig(): AtomicAgentConfig {
  const fresh = freshScope.getStore();
  if (fresh) return fresh;
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}

/**
 * Run `fn` with `getConfig()` answering a config loaded from disk now, for
 * `fn` and everything it awaits only. Everyone else keeps the cached one.
 */
export function withFreshConfig<T>(fn: () => Promise<T>): Promise<T> {
  let fresh: AtomicAgentConfig;
  try {
    fresh = loadConfig();
  } catch {
    // A file that does not load now (mid-write, broken): answer from the cached one, as before.
    return fn();
  }
  return freshScope.run(fresh, fn);
}
