/**
 * Re-validate an event against catalog.ts before it can leave the machine.
 *
 *  - unknown event → dropped (null);
 *  - unknown property → dropped;
 *  - enum value not in the list → `other` (or the prop's own fallback), or
 *    dropped when the prop has neither;
 *  - strings: ≤64 chars, `^[a-zA-Z0-9_.:-]*$`, then the prop's own `clean`
 *    (ui_action ids, quant, locale), else the prop's fallback or dropped;
 *  - numbers: finite, clamped to the prop's range, ints truncated;
 *  - tool lists: built-in names only, any MCP tool → `mcp`, dedup, max 20.
 *
 * Pure: no Electron, no fs — the unit tests drive it straight.
 */

import { EVENTS, type EventSpec, type PropSpec } from "./catalog.js";

export const SAFE_STRING_RE = /^[a-zA-Z0-9_.:-]*$/;
export const MAX_STRING = 64;
const TOOL_NAME_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_TOOLS = 20;

export type Props = Record<string, unknown>;

export function safeString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  if (v.length > MAX_STRING || !SAFE_STRING_RE.test(v)) return undefined;
  return v;
}

/** `mcp.<server>.<tool>` names carry a server name the user chose: any of them is `mcp`. */
export function toolBucket(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  if (name === "mcp" || name.startsWith("mcp.") || name.startsWith("mcp__")) return "mcp";
  return TOOL_NAME_RE.test(name) ? name : undefined;
}

function cleanTools(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const t of v) {
    const b = toolBucket(t);
    if (b && !out.includes(b)) out.push(b);
    if (out.length >= MAX_TOOLS) break;
  }
  return out;
}

function cleanNumber(v: unknown, spec: { min?: number; max?: number }, integer: boolean, decimals?: number): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  let n = integer ? Math.trunc(v) : v;
  if (spec.min !== undefined && n < spec.min) n = spec.min;
  if (spec.max !== undefined && n > spec.max) n = spec.max;
  if (!integer && decimals !== undefined) {
    const f = 10 ** decimals;
    n = Math.round(n * f) / f;
  }
  return n;
}

/** One property; `undefined` means "drop it". */
export function cleanProp(spec: PropSpec, v: unknown): unknown {
  if (v === null) return "nullable" in spec && spec.nullable ? null : undefined;
  switch (spec.kind) {
    case "enum": {
      if (typeof v === "string" && spec.values.includes(v)) return v;
      if (v === undefined) return undefined;
      const fb = spec.fallback ?? (spec.values.includes("other") ? "other" : undefined);
      return fb;
    }
    case "int":
      return cleanNumber(v, spec, true);
    case "num":
      return cleanNumber(v, spec, false, spec.decimals);
    case "bool":
      return typeof v === "boolean" ? v : undefined;
    case "str": {
      const str = safeString(v);
      if (!spec.clean) return str ?? spec.fallback;
      return (str === undefined ? undefined : spec.clean(str)) ?? spec.fallback;
    }
    case "tools":
      return cleanTools(v);
    case "boolMap":
    case "intMap": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
      const out: Record<string, boolean | number> = {};
      for (const k of spec.keys) {
        const x = (v as Record<string, unknown>)[k];
        if (spec.kind === "boolMap" && typeof x === "boolean") out[k] = x;
        if (spec.kind === "intMap") {
          const n = typeof x === "boolean" ? (x ? 1 : 0) : cleanNumber(x, { min: 0 }, true);
          if (n !== undefined) out[k] = n;
        }
      }
      return out;
    }
  }
}

/**
 * The whole event. Returns null when the event is not in the catalogue or
 * (with `from: "ui"`) is not one the renderer owns.
 */
export function validateEvent(
  event: unknown,
  props: unknown,
  from: "main" | "ui",
  catalog: Record<string, EventSpec> = EVENTS,
): { event: string; props: Props } | null {
  if (typeof event !== "string" || !Object.prototype.hasOwnProperty.call(catalog, event)) return null;
  const spec = catalog[event]!;
  if (from === "ui" && spec.owner !== "ui") return null;
  const raw = props && typeof props === "object" && !Array.isArray(props) ? (props as Props) : {};
  const out: Props = {};
  for (const [name, ps] of Object.entries(spec.props)) {
    if (!Object.prototype.hasOwnProperty.call(raw, name)) continue;
    const cleaned = cleanProp(ps, raw[name]);
    if (cleaned !== undefined) out[name] = cleaned;
  }
  return { event, props: out };
}
