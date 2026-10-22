import { configBranchKind, knownConfigKeys } from "./config-shape.js";

/** Never copied: assigning them reparents or pollutes objects. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Put back the keys a newer build wrote into fixed blocks of the file on
 * disk that this build does not know, so writing `data` cannot delete
 * them (ATO-417).
 *
 * `parseUserConfigFile` rebuilds every known block from a fixed literal,
 * so `memory.futureKey` or `tui.onboarding.futureStamp` from a newer
 * build never reach `data`; writing it out as-is is how an older build
 * erased the newer build's settings. Rules, per fixed block
 * (`config-shape.ts`):
 *
 * - A key this build knows always comes from `data`, present or not:
 *   absent means the caller removed it on purpose.
 * - A key it does not know comes from disk, unless `data` already has
 *   it (unknown top-level blocks already ride along through the parse).
 * - Dictionaries, arrays and unclassified nodes are not descended:
 *   there `data` is the whole value, so a removed MCP server or
 *   provider stays removed.
 * - `__proto__`, `constructor` and `prototype` are never copied.
 *
 * Returns `data` itself when nothing needed carrying; never mutates
 * either argument.
 */
export function carryUnknownConfigKeys<T extends object>(
  data: T,
  disk: Record<string, unknown>,
): T {
  return carryInto(
    "",
    data as unknown as Record<string, unknown>,
    disk,
  ) as unknown as T;
}

function carryInto(
  path: string,
  data: Record<string, unknown>,
  disk: Record<string, unknown>,
): Record<string, unknown> {
  const known = knownConfigKeys(path);
  const carried: Record<string, unknown> = {};
  let changed = false;
  for (const [key, value] of Object.entries(disk)) {
    if (UNSAFE_KEYS.has(key) || known.has(key) || Object.hasOwn(data, key)) {
      continue;
    }
    carried[key] = value;
    changed = true;
  }
  for (const key of known) {
    const childPath = path === "" ? key : `${path}.${key}`;
    if (configBranchKind(childPath) !== "fixed") continue;
    const child = Object.hasOwn(data, key) ? data[key] : undefined;
    const childOnDisk = Object.hasOwn(disk, key) ? disk[key] : undefined;
    if (!isPlainObject(child) || !isPlainObject(childOnDisk)) continue;
    const merged = carryInto(childPath, child, childOnDisk);
    if (merged === child) continue;
    carried[key] = merged;
    changed = true;
  }
  return changed ? { ...data, ...carried } : data;
}
