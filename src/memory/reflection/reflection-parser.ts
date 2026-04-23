/**
 * Parse the completion produced under `REFLECTION_GRAMMAR`. The grammar
 * already guarantees the raw shape, but we still validate defensively
 * because the parser also runs in non-grammar test paths and against
 * legacy completions.
 *
 * The parser is tolerant of the exact line terminator (LF / CRLF / none)
 * and optional trailing whitespace — the grammar allows either `NONE\n`
 * or `NONE` and the runner must accept both verbatim.
 */

export interface ReflectionFact {
  key: string;
  value: string;
}

export interface ParsedReflection {
  kind: "none" | "facts";
  facts: ReflectionFact[];
}

/**
 * Parse a reflection completion string. Returns `{ kind: "none" }` when
 * the model declared it has nothing to remember. Malformed lines are
 * silently skipped; callers should rely on the grammar + `ProfileStore`
 * validators to reject garbage. Duplicate keys are deduplicated keeping
 * the last value (matches `ProfileStore.set` upsert semantics).
 */
export function parseReflectionOutput(raw: string): ParsedReflection {
  const text = raw.trim();
  if (text.length === 0 || text === "NONE") {
    return { kind: "none", facts: [] };
  }

  const byKey = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseSetLine(line);
    if (parsed) byKey.set(parsed.key, parsed.value);
  }

  if (byKey.size === 0) return { kind: "none", facts: [] };

  const facts: ReflectionFact[] = [];
  for (const [key, value] of byKey) facts.push({ key, value });
  return { kind: "facts", facts };
}

function parseSetLine(raw: string): ReflectionFact | null {
  const line = raw.trimEnd();
  if (!line.startsWith("SET ")) return null;
  const body = line.slice(4);
  const eq = body.indexOf("=");
  if (eq <= 0) return null;
  const key = body.slice(0, eq).trim();
  const value = body.slice(eq + 1);
  if (key.length === 0 || value.length === 0) return null;
  return { key, value };
}
