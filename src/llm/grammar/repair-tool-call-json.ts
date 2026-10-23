/**
 * Mechanical repair of a tool call's broken JSON (ATO-637).
 *
 * A trailing comma, a single-quoted string, a raw newline inside a
 * string or a bracket the model never closed used to cost a whole
 * repair round-trip (a second completion with a corrective notice).
 * This fixes those few shapes in code first. It is deliberately small
 * and conservative, written here rather than pulled in as a dependency:
 *
 * - code fences around the value are dropped;
 * - a single-quoted string becomes a double-quoted one;
 * - a raw newline, carriage return or tab inside a string is escaped;
 * - a comma right before a closing bracket is removed;
 * - at the very end, an open string is closed and open brackets are
 *   closed in order.
 *
 * Anything else (a closer that does not match its opener, a key with no
 * value at the end, text that still does not parse) returns `null`, and
 * the caller keeps its original parse error.
 *
 * The result says which fixes were applied and whether the text had to
 * be closed at the end, because a closed value may be cut short: the
 * step decides whether a repaired call may run (`step-json-repair.ts`).
 * This module never sees tools or schemas.
 */

/** What a repair changed, for the caller's acceptance check and log. */
export interface JsonRepairReport {
  /** Short names of the fixes applied, in first-seen order. */
  fixes: string[];
  /** A string was still open at the end and got closed. */
  closedString: boolean;
  /** At least one bracket was still open at the end and got closed. */
  closedBrackets: boolean;
}

export interface JsonRepairResult extends JsonRepairReport {
  text: string;
  value: unknown;
}

export const JSON_FIX = {
  codeFence: "code fence",
  singleQuotes: "single quotes",
  rawControl: "raw newline in string",
  trailingComma: "trailing comma",
  unclosedString: "unclosed string",
  unclosedBrackets: "unclosed brackets",
} as const;

const FENCE_OPEN = /^```[A-Za-z0-9_-]*[ \t]*\r?\n?/;
const FENCE_CLOSE = /\r?\n?```\s*$/;

/**
 * Repair `input` into parseable JSON, or `null` when it already parses
 * (nothing to repair) or no repair here makes it parse.
 */
export function repairJsonText(input: string): JsonRepairResult | null {
  const fixes = new Set<string>();
  let text = input.trim();
  if (text.length === 0) return null;
  if (FENCE_OPEN.test(text)) {
    text = text.replace(FENCE_OPEN, "").replace(FENCE_CLOSE, "").trim();
    fixes.add(JSON_FIX.codeFence);
  }

  let out = "";
  const stack: Array<"}" | "]"> = [];
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === "\\") {
        const next = text[i + 1];
        if (next === undefined) break;
        // `\'` is not a JSON escape; inside a single-quoted string it
        // just means a quote.
        out += quote === "'" && next === "'" ? "'" : `\\${next}`;
        i += 1;
        continue;
      }
      if (ch === quote) {
        out += '"';
        quote = null;
        continue;
      }
      if (ch === '"') {
        out += '\\"';
        continue;
      }
      if (ch === "\n" || ch === "\r" || ch === "\t") {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : "\\t";
        fixes.add(JSON_FIX.rawControl);
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (ch === "'") fixes.add(JSON_FIX.singleQuotes);
      quote = ch;
      out += '"';
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
      out += ch;
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return null;
      out = dropTrailingComma(out, fixes);
      out += ch;
      continue;
    }
    out += ch;
  }

  let closedString = false;
  if (quote !== null) {
    out += '"';
    closedString = true;
    fixes.add(JSON_FIX.unclosedString);
  }
  if (stack.length > 0) {
    out = dropTrailingComma(out, fixes);
    // A key waiting for its value has nothing honest to close with.
    if (/:\s*$/.test(out)) return null;
    while (stack.length > 0) out += stack.pop();
    fixes.add(JSON_FIX.unclosedBrackets);
  }
  const closedBrackets = fixes.has(JSON_FIX.unclosedBrackets);

  if (fixes.size === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(out);
  } catch {
    return null;
  }
  return { text: out, value, fixes: [...fixes], closedString, closedBrackets };
}

/** Merge one repair into a running report (several args strings in one batch). */
export function mergeJsonRepair(
  into: JsonRepairReport | undefined,
  next: JsonRepairReport,
): JsonRepairReport {
  if (into === undefined) return { ...next, fixes: [...next.fixes] };
  return {
    fixes: [...new Set([...into.fixes, ...next.fixes])],
    closedString: into.closedString || next.closedString,
    closedBrackets: into.closedBrackets || next.closedBrackets,
  };
}

function dropTrailingComma(out: string, fixes: Set<string>): string {
  const trimmed = out.replace(/\s+$/, "");
  if (!trimmed.endsWith(",")) return out;
  fixes.add(JSON_FIX.trailingComma);
  return trimmed.slice(0, -1);
}
