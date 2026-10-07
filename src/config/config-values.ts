import { ConfigValidationError } from "./config-validation-error.js";
import { parseNonEmptyString } from "./config-primitives.js";

export function parseStringArrayOrNull(
  raw: unknown,
  field: string,
): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(
      field,
      `expected string[] or null, got ${JSON.stringify(raw)}`,
    );
  }
  const result: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ConfigValidationError(
        `${field}[${i}]`,
        `expected non-empty string, got ${JSON.stringify(entry)}`,
      );
    }
    result.push(entry);
  }
  return result;
}

export function parseUrl(raw: unknown, field: string): string {
  const str = parseNonEmptyString(raw, field);
  try {
    new URL(str);
    return str;
  } catch {
    throw new ConfigValidationError(
      field,
      `expected valid URL, got ${JSON.stringify(raw)}`,
    );
  }
}

/**
 * Parse an optional string that is meaningfully absent. `undefined`
 * (key missing) and `null` (explicitly cleared) both read as `null`,
 * so a cleared cache entry and a never-written one behave alike.
 */
export function parseNullableString(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  throw new ConfigValidationError(
    field,
    `expected string or null, got ${JSON.stringify(raw)}`,
  );
}
