import { existsSync, readFileSync } from "node:fs";

/**
 * Read a single key's value from a dotenv file without mutating it.
 * Mirrors the `loadDotenvFromStateDir` parse (trim, strip one surrounding
 * quote pair, ignore comments). Returns `undefined` when absent.
 *
 * Shared by the importers that reconcile migrated provider keys against
 * the agent's own `<stateDir>/.env`.
 */
export function readDotenvValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== key) continue;
    return stripDotenvQuotes(trimmed.slice(eq + 1).trim());
  }
  return undefined;
}

/** Strip a single matching pair of surrounding single or double quotes. */
export function stripDotenvQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
