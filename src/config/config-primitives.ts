import { ConfigValidationError } from "./config-validation-error.js";

/**
 * Coerce a raw config value to a number for validation.
 *
 * A string must be a *complete* numeric literal. `Number.parseInt` stops at
 * the first character it cannot read, so it turns `"1e3"` into `1`, `"60s"`
 * into `60` and `"100_000"` into `100` — a typo silently becomes a valid
 * setting. That is reachable from `config set <key> <value>`, where every
 * value arrives as a string, so the whole token is parsed here and anything
 * that is not a complete numeric literal is rejected as `NaN`.
 *
 * The test is on the *whole token*, not on its shape: `"10.0"` and `"1e3"`
 * are both complete literals, and `parseInt` converted the first correctly
 * (to `10`) while truncating the second. Rejecting every non-`\d+` string
 * would therefore also reject values that already worked — and since this
 * parser runs on `loadConfig` at every startup, a `config.json` holding
 * `"8080.0"` would make the whole CLI unbootable with no way to fix it from
 * inside the tool. So the value is what decides: parse it in full, then
 * require it to be an exact integer. `"10.0"` passes, `"1e3"` (1000) passes
 * as the thousand the user asked for, `"60s"` and `"10.9"` do not.
 */
export function coerceIntLike(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return NaN;
  const value = coerceFloatLike(raw);
  // `Number.isInteger` also rejects NaN and the infinities.
  if (!Number.isInteger(value)) return NaN;
  // Past 2^53 the literal no longer round-trips: "9007199254740993" would be
  // silently stored as ...992, which is the same class of quiet corruption
  // this function exists to stop.
  return Number.isSafeInteger(value) ? value : NaN;
}

/**
 * The float counterpart of {@link coerceIntLike}. Accepts the forms JSON
 * does — `1.5`, `-0.25`, `1e3` — and rejects trailing garbage like
 * `"0.85xyz"` or a second dot, which `Number.parseFloat` would truncate.
 */
export function coerceFloatLike(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return NaN;
  const text = raw.trim();
  if (text.length === 0) return NaN;
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)
    ? Number(text)
    : NaN;
}

export function parsePositiveInt(raw: unknown, field: string): number {
  const value = coerceIntLike(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new ConfigValidationError(
      field,
      `expected positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * Parse a positive integer that must lie inside a closed `[min, max]`
 * range. Used by user-config knobs that have hard physical bounds
 * (e.g. `completionMaxTokens`). Out-of-range values throw — the env
 * counterpart silently clamps because operator-supplied env vars are
 * less strict than file-supplied user config.
 */
export function parseBoundedPositiveInt(
  raw: unknown,
  field: string,
  min: number,
  max: number,
): number {
  const value = parsePositiveInt(raw, field);
  if (value < min || value > max) {
    throw new ConfigValidationError(
      field,
      `expected integer in [${min}, ${max}], got ${value}`,
    );
  }
  return value;
}

/**
 * Parse a non-negative integer (includes `0`). Used for caps that
 * accept `0` as "feature disabled", e.g. `memory.reflection.maxNotesPerCall`.
 */
export function parseNonNegativeInt(raw: unknown, field: string): number {
  const value = coerceIntLike(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new ConfigValidationError(
      field,
      `expected non-negative integer, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * Parse a non-negative integer constrained to `[min, max]`. Unlike
 * {@link parseBoundedPositiveInt}, `min` may be `0` (e.g. a TTL where `0`
 * disables caching).
 */
export function parseNonNegativeBoundedInt(
  raw: unknown,
  field: string,
  min: number,
  max: number,
): number {
  const value = parseNonNegativeInt(raw, field);
  if (value < min || value > max) {
    throw new ConfigValidationError(
      field,
      `expected integer in [${min}, ${max}], got ${value}`,
    );
  }
  return value;
}

/**
 * Parse a number in the unit interval `[0, 1]`. Accepts JSON numbers
 * (canonical) or stringified numbers (env / form-encoded). Used by
 * memory-v2 thresholds (`memory.dedup.fts5Threshold`, future
 * `memory.consolidation.similarityThreshold`, etc.) so similarity
 * configs are bounded by the storage layer rather than each caller
 * re-deriving the clamp.
 */
export function parseUnitInterval(raw: unknown, field: string): number {
  const value = coerceFloatLike(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ConfigValidationError(
      field,
      `expected number in [0, 1], got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * Parse a number in `(0, 1]` — strict positive lower bound,
 * inclusive at `1`. Used by `memory.voting.signalDecay` where `0`
 * is forbidden (a zero decay zeroes every score on the next tick,
 * which trivially destroys all signal) but `1` is allowed (no
 * decay at all, mostly useful for tests and offline replay).
 */
export function parseHalfOpenUnitInterval(raw: unknown, field: string): number {
  const value = coerceFloatLike(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new ConfigValidationError(
      field,
      `expected number in (0, 1], got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

export function parseBool(raw: unknown, field: string): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const lc = raw.toLowerCase();
    if (["1", "true", "yes", "on"].includes(lc)) return true;
    if (["0", "false", "no", "off"].includes(lc)) return false;
  }
  throw new ConfigValidationError(
    field,
    `expected boolean, got ${JSON.stringify(raw)}`,
  );
}

/**
 * Parse a tri-state toggle: `null` means "defer to the caller". Used by
 * `tracing.trace.enabled` so users can leave the decision to the
 * entry-point default (CLI on, sidecar off) or pin it explicitly.
 */
export function parseBoolOrNull(raw: unknown, field: string): boolean | null {
  if (raw === null || raw === undefined) return null;
  return parseBool(raw, field);
}

export function parseNonEmptyString(raw: unknown, field: string): string {
  if (typeof raw === "string" && raw.length > 0) return raw;
  throw new ConfigValidationError(
    field,
    `expected non-empty string, got ${JSON.stringify(raw)}`,
  );
}
