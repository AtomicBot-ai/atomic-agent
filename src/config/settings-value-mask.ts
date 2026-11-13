import { formatConfigValue, isSecretConfigKey } from "./config-paths.js";

/**
 * Masking for the settings reference (ATO-41): `config list --json` /
 * `--describe`, the TUI's `/settings` and, through `--json`, the
 * desktop's All settings list. `formatConfigValue` alone only masks a
 * string at a secret-named leaf, which lets whole objects through
 * (`mcp.servers[].env.GITHUB_TOKEN`, `transport.headers.Authorization`).
 */

const MASK = "***";

/** Maps whose every value may be a credential: MCP `env`, HTTP `headers`. */
const MASK_ALL_MAPS = new Set(["env", "headers"]);

function lastSegment(key: string): string {
  return key.slice(key.lastIndexOf(".") + 1);
}

/**
 * A value as `config list` prints it, secrets masked at any depth, never
 * the raw string. Objects and arrays are walked: a secret-named key
 * (`token`, `apiKey`, `secret`, `password`, ...) is masked wherever it
 * sits, and every value under an `env` or `headers` map is masked, since
 * `GITHUB_TOKEN` or `Authorization` there does not look secret by name.
 * The desktop's All settings list renders these values as they come.
 */
export function maskSettingValue(key: string, value: unknown): unknown {
  return maskNode(value, maskModeFor(lastSegment(key), "none"));
}

/**
 * `none`: print as is. `strings`: under a secret-named key, mask strings
 * (a `tokenBudget` number stays readable). `all`: under `env` / `headers`,
 * mask every value but null and booleans.
 */
type MaskMode = "none" | "strings" | "all";

function maskModeFor(name: string, parent: MaskMode): MaskMode {
  if (parent === "all" || MASK_ALL_MAPS.has(name.toLowerCase())) return "all";
  if (parent === "strings" || isSecretConfigKey(name)) return "strings";
  return "none";
}

function maskNode(value: unknown, mode: MaskMode): unknown {
  if (Array.isArray(value)) return value.map((item) => maskNode(item, mode));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [child, inner] of Object.entries(value as Record<string, unknown>)) {
      out[child] = maskNode(inner, maskModeFor(child, mode));
    }
    return out;
  }
  if (mode === "none") return value;
  if (typeof value === "string") return value.length > 0 ? MASK : value;
  if (mode === "strings" || value === null || value === undefined || typeof value === "boolean") return value;
  return MASK;
}

/** `maskSettingValue`, rendered the way `config list` prints a value. */
export function formatSettingValue(key: string, value: unknown): string {
  return formatConfigValue(key, maskSettingValue(key, value));
}
