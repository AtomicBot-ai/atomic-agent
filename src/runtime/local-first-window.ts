import type { AtomicAgentConfig } from "../config/index.js";
import { readLaunchRecord, readRunningPid } from "../local-llm/index.js";

/** The built-in managed local link (`LlamaServerProvider`'s default id). */
const MANAGED_LOCAL_LINK = "local-llama";

export interface LocalFirstWindowDeps {
  /** The window the live local profile reports (`/props`), when it was read. */
  liveWindow: () => number | null | undefined;
  /** The catalogue's (or a probe's) window for this link, or null. */
  catalogWindow: (providerId: string) => number | null;
  readConfig: () => Pick<AtomicAgentConfig, "localModels" | "paths">;
  /** The `--ctx-size` the running managed model was launched with, or null. */
  launchContextSize?: (dataDir: string) => number | null;
}

const readLaunchContextSize = (dataDir: string): number | null =>
  readLaunchRecord(dataDir, readRunningPid(dataDir))?.contextSize ?? null;

const positive = (n: number | null | undefined): number | null =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;

/**
 * The window the local-first size check (ATO-2537) sizes a local link
 * against. The live profile is only read once local inference ran in this
 * process, so right after a restart it is empty, and a llama-server link
 * has no catalogue window: the turn that resumes a long session would see
 * "unknown". For the managed link the running daemon's launch record and
 * a fixed `localModels.managed.contextSize` say it without a request.
 * Null when nothing does; the check then treats a long history as too
 * long (`UNKNOWN_WINDOW_HISTORY_LIMIT`).
 */
export function createLocalFirstWindowResolver(
  deps: LocalFirstWindowDeps,
): (providerId: string) => number | null {
  const launchContextSize = deps.launchContextSize ?? readLaunchContextSize;
  return (providerId) => {
    const live = positive(deps.liveWindow());
    if (live !== null) return live;
    const catalogued = positive(deps.catalogWindow(providerId));
    if (catalogued !== null) return catalogued;
    if (providerId !== MANAGED_LOCAL_LINK) return null;
    const config = deps.readConfig();
    if (config.localModels.mode !== "managed") return null;
    try {
      const launched = positive(launchContextSize(config.paths.localModelsDataDir));
      if (launched !== null) return launched;
    } catch {
      // An unreadable record says nothing; the configured size may.
    }
    return positive(config.localModels.managed.contextSize);
  };
}
