import { ConfigValidationError } from "./config-validation-error.js";

/**
 * The user's own shell-guard rules (config v77, issue #229). Patterns
 * are dull globs over the normalised command line, anchored at argv[0]:
 * `"npm run *"` covers `npm run` and anything after it, `"git status"`
 * covers exactly that. Stored in the user's own `config.json` — never a
 * repo-supplied file, so a clone cannot ship rules the agent would
 * honour before the operator has read them (the trust concern the issue
 * thread converged on). A deny-listed command never runs silently: it
 * goes to the approval ladder, and an unanswered or declined prompt
 * stops it. An allow-listed command runs without a prompt, below the
 * built-in dangerous layers — no pattern can widen past those.
 */
export interface ShellGuardConfig {
  /** Commands that must never run without a person's yes. */
  deny: string[];
  /** Commands the operator pre-approves for unattended runs. */
  allow: string[];
}

/** A pattern's total length cap — a guard config is not a script. */
const MAX_PATTERN_LENGTH = 200;
/** A list's entry cap, so a fat config cannot slow the guard's hot path. */
const MAX_PATTERNS = 256;

export function createShellGuardDefaults(): ShellGuardConfig {
  return {
    // Added in v77. Empty by default: with no rules the guard behaves
    // exactly as before — the user layer only exists once the operator
    // writes one.
    deny: [],
    allow: [],
  };
}

export function parseShellGuardConfig(
  raw: Record<string, unknown>,
  readDefaults: () => ShellGuardConfig,
): ShellGuardConfig {
  return {
    deny: parseShellGuardPatternArray(
      raw.deny,
      "shellGuard.deny",
      readDefaults().deny,
    ),
    allow: parseShellGuardPatternArray(
      raw.allow,
      "shellGuard.allow",
      readDefaults().allow,
    ),
  };
}

/**
 * A list of guard patterns: non-empty strings, trimmed, de-duplicated
 * (first occurrence wins), bounded in count and length so a bloated
 * config cannot tax every shell call. The matcher itself re-trims and
 * tokenises, so what lands here is validation, not parsing.
 */
function parseShellGuardPatternArray(
  raw: unknown,
  field: string,
  fallback: readonly string[],
): string[] {
  if (raw === undefined || raw === null) return [...fallback];
  if (!Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected string[]");
  }
  if (raw.length > MAX_PATTERNS) {
    throw new ConfigValidationError(
      field,
      `expected at most ${MAX_PATTERNS} patterns, got ${raw.length}`,
    );
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (typeof entry !== "string") {
      throw new ConfigValidationError(
        `${field}[${i}]`,
        `expected a string, got ${JSON.stringify(entry)}`,
      );
    }
    const pattern = entry.trim();
    if (pattern.length === 0) {
      throw new ConfigValidationError(
        `${field}[${i}]`,
        "expected a non-empty pattern",
      );
    }
    if (pattern.length > MAX_PATTERN_LENGTH) {
      throw new ConfigValidationError(
        `${field}[${i}]`,
        `pattern longer than ${MAX_PATTERN_LENGTH} characters`,
      );
    }
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    result.push(pattern);
  }
  return result;
}
