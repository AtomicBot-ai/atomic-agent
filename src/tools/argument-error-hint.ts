import { getDefaultArgsJsonSchema } from "../prompt/default-tool-args-schemas.js";

/**
 * What a tool's argument error should also say: which keys arrived,
 * which the tool accepts, and the closest accepted key for any that it
 * does not.
 *
 * A worker once sent `patternes` to `os.fs.grep`, another sent the keys
 * `"\"path\""` and `"<label>…</label>,limit"` to `os.fs.read`. Each got
 * "`path` must be a non-empty string" back — true, and useless: the
 * message names the missing key but not the key the model actually
 * used, so it retried the same call blind. The keys are echoed, never
 * the values: a value can be a whole file.
 */
export interface ArgumentErrorHint {
  /** The original message with the key report appended. */
  readonly message: string;
  readonly receivedKeys: readonly string[];
  /** Empty when the tool has no registered args schema (MCP tools). */
  readonly expectedKeys: readonly string[];
  /** Received keys the tool does not accept, with their closest accepted key. */
  readonly nearest: ReadonlyArray<{ received: string; expected: string }>;
}

/** Largest edit distance at which a received key still "means" an expected one. */
export const NEAREST_KEY_MAX_DISTANCE = 2;

/**
 * The wording tools use when they reject their arguments. A backticked
 * identifier is the strongest signal (every built-in names the field
 * that way); the phrases cover the few that do not.
 */
const ARGUMENT_ERROR_WORDING =
  /`[^`]+`|\bmust be\b|\bis required\b|\brequired\b|\bprovide (?:either|a|an|the|one)\b|\bmissing\b|\bunknown (?:arg|argument|field|key|option)\b|\bnot allowed\b/i;

/**
 * The hint for an error a tool threw on its arguments, or `null` when
 * the message does not read as an argument error — a runtime failure
 * (ENOENT, a timeout, an approval refusal) gets no key report, which
 * would only be noise there.
 */
export function describeArgumentError(input: {
  tool: string;
  args: Record<string, unknown>;
  message: string;
}): ArgumentErrorHint | null {
  if (!ARGUMENT_ERROR_WORDING.test(input.message)) return null;
  const receivedKeys = Object.keys(input.args);
  const expectedKeys = expectedKeysFor(input.tool);
  const expectedSet = new Set(expectedKeys);
  const nearest: Array<{ received: string; expected: string }> = [];
  for (const received of receivedKeys) {
    if (expectedSet.has(received)) continue;
    const match = nearestKey(received, expectedKeys);
    if (match !== null) nearest.push({ received, expected: match });
  }
  const parts = [
    `received keys: ${receivedKeys.length > 0 ? receivedKeys.join(", ") : "(none)"}`,
  ];
  if (expectedKeys.length > 0) parts.push(`expected: ${expectedKeys.join(", ")}`);
  for (const { received, expected } of nearest) {
    parts.push(`did you mean \`${expected}\` instead of \`${received}\`?`);
  }
  return {
    message: `${input.message} — ${parts.join("; ")}`,
    receivedKeys,
    expectedKeys,
    nearest,
  };
}

function expectedKeysFor(tool: string): string[] {
  const schema = getDefaultArgsJsonSchema(tool);
  const properties = schema?.properties;
  if (
    properties === null ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    return [];
  }
  return Object.keys(properties as Record<string, unknown>);
}

/**
 * The expected key closest to `received` within
 * `NEAREST_KEY_MAX_DISTANCE`, comparing case-insensitively; ties go to
 * the first in schema order.
 */
export function nearestKey(
  received: string,
  expected: readonly string[],
): string | null {
  let best: { key: string; distance: number } | null = null;
  const needle = received.toLowerCase();
  for (const key of expected) {
    const distance = editDistance(needle, key.toLowerCase());
    if (distance > NEAREST_KEY_MAX_DISTANCE) continue;
    if (best === null || distance < best.distance) best = { key, distance };
  }
  return best?.key ?? null;
}

/** Levenshtein distance; keys are short, so the plain two-row form is enough. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(
        Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}
