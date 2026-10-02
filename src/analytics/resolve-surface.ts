/**
 * Which product surface an analytics event came from:
 *   - `desktop` — the agent spawned by the desktop app (it sets
 *     `ATOMIC_AGENT_SURFACE=desktop` in the child's env);
 *   - `tui`     — the interactive terminal UI;
 *   - `cli`     — every headless entry point (`run`, `task`, `serve`,
 *     the sidecar, `config`).
 */
export type AnalyticsSurface = "desktop" | "tui" | "cli";

const SURFACES: readonly AnalyticsSurface[] = ["desktop", "tui", "cli"];

/** Environment variable the desktop app sets on the agent it spawns. */
export const SURFACE_ENV = "ATOMIC_AGENT_SURFACE";

/** Narrow an arbitrary value to a known surface, else `undefined`. */
export function parseSurface(value: unknown): AnalyticsSurface | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return (SURFACES as readonly string[]).includes(trimmed)
    ? (trimmed as AnalyticsSurface)
    : undefined;
}

/**
 * Resolve the surface for this process: an explicit value from the entry
 * point wins (the TUI passes `tui`), then `ATOMIC_AGENT_SURFACE` from the
 * environment, else `cli`. Headless entry points pass nothing so a
 * desktop-spawned `serve` / sidecar still reports `desktop`. Unknown
 * values are ignored, never forwarded.
 */
export function resolveSurface(
  explicit?: AnalyticsSurface,
  env: NodeJS.ProcessEnv = process.env,
): AnalyticsSurface {
  return parseSurface(explicit) ?? parseSurface(env[SURFACE_ENV]) ?? "cli";
}
