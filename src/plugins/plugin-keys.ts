/** Filled in by the loader from the plugin's own folders: never one of the user's keys. */
export const PLUGIN_VAR_NAMES: ReadonlySet<string> = new Set(["CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "PLUGIN_ROOT", "PLUGIN_DATA"]);

/** `${NAME}` or `${NAME:-default}`. */
export const USER_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * The user's keys an MCP server entry refers to, sorted. A plugin that
 * receives the user's keys is trusted like one that runs code: same flag,
 * same consent (`runsCodeAccepted`).
 */
export function userKeyRefs(value: unknown): string[] {
  const names = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(USER_VAR_RE)) if (!PLUGIN_VAR_NAMES.has(m[1]!)) names.add(m[1]!);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(value);
  return [...names].sort();
}
