import fuzzysort from "fuzzysort";
import type { ToolDescriptor } from "../../prompt/stable-prefix.js";

/**
 * Rank tools for a free-text query: name parts, the description and the
 * argument names, word by word. Every query word scores on its own (a
 * model writes "post a message to slack", not a subsequence of
 * `mcp.slack.chat_post_message`), so a tool matching most of the words
 * beats one matching a single word very well. `fuzzysort` only rescues
 * near-misses in names (`slak`, `notion_serch`).
 */

const STOP_WORDS = new Set([
  "a", "an", "the", "to", "for", "of", "in", "on", "and", "or", "with", "my",
  "me", "i", "tool", "tools", "please", "use", "using", "from", "by", "into",
  "is", "it", "this", "that", "some", "any", "can", "how", "what", "which",
  "find", "need", "want", "do", "via", "call",
]);

export interface ScoredTool {
  descriptor: ToolDescriptor;
  score: number;
  /** Query words this tool matched. */
  matched: number;
}

export function queryWords(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  return [...new Set(words)];
}

/** Argument names of a descriptor: JSON schema properties, else keys in the text sketch. */
export function argNames(d: ToolDescriptor): string[] {
  const props = (d.argsJsonSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (props && typeof props === "object") return Object.keys(props);
  return [...d.argsSchema.matchAll(/([A-Za-z_][\w]*)\??\s*:/g)].map((m) => m[1]!);
}

function nameParts(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function wordIn(text: string, word: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${word}`, "i").test(text);
}

export function searchTools(
  query: string,
  descriptors: readonly ToolDescriptor[],
  limit: number,
): ScoredTool[] {
  const trimmed = query.trim().toLowerCase();
  const words = queryWords(query);
  if (trimmed.length === 0) return [];
  const scored: (ScoredTool & { index: number })[] = [];
  descriptors.forEach((descriptor, index) => {
    const name = descriptor.name.toLowerCase();
    // A query that IS a tool name (the model copied it from `# extras`).
    if (trimmed === name) {
      scored.push({ descriptor, score: 1_000, matched: words.length, index });
      return;
    }
    const parts = nameParts(descriptor.name);
    const summary = descriptor.summary.toLowerCase();
    const args = argNames(descriptor).flatMap(nameParts);
    let score = 0;
    let matched = 0;
    for (const word of words) {
      let best = 0;
      if (parts.includes(word)) best = 3;
      else if (parts.some((p) => p.startsWith(word) || (word.length >= 4 && p.includes(word)))) best = 2.5;
      else if (word.length >= 4) {
        const fuzzy = fuzzysort.single(word, name);
        if (fuzzy && fuzzy.score >= 0.4) best = 2 * fuzzy.score;
      }
      if (best < 1.5 && wordIn(summary, word)) best = 1.5;
      if (best < 1.2 && args.includes(word)) best = 1.2;
      if (best > 0) {
        matched += 1;
        score += best;
      }
    }
    if (matched === 0) return;
    // Covering more of the query beats one strong hit.
    score *= 0.5 + (0.5 * matched) / Math.max(1, words.length);
    scored.push({ descriptor, score, matched, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, Math.max(0, limit)).map(({ descriptor, score, matched }) => ({ descriptor, score, matched }));
}

function placeholder(name: string, schema: unknown): unknown {
  const type = (schema as { type?: unknown } | undefined)?.type;
  const enumValues = (schema as { enum?: unknown } | undefined)?.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0];
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return false;
  if (type === "array") return [];
  if (type === "object") return {};
  return `<${name}>`;
}

/**
 * The call a model can copy: the descriptor's first example when it has
 * one, else its required arguments with `<name>` placeholders.
 */
export function callShape(d: ToolDescriptor): string {
  const example = d.examples?.[0];
  if (example !== undefined) {
    try {
      return JSON.stringify({ tool: d.name, args: JSON.parse(example) as unknown });
    } catch {
      // A non-JSON example (rare): fall through to the schema.
    }
  }
  const schema = d.argsJsonSchema as { properties?: Record<string, unknown>; required?: unknown } | undefined;
  const args: Record<string, unknown> = {};
  if (schema?.properties) {
    const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
    for (const key of required) {
      if (typeof key === "string") args[key] = placeholder(key, schema.properties[key]);
    }
  } else {
    for (const m of d.argsSchema.matchAll(/([A-Za-z_][\w]*)\s*:\s*([a-z]+)/g)) {
      args[m[1]!] = placeholder(m[1]!, { type: m[2] });
    }
  }
  return JSON.stringify({ tool: d.name, args });
}
