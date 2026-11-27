/**
 * Frontmatter of path-scoped rule files (ATO-2247): which files a rule is for.
 * `.atomic-agent/rules/*.md` uses `paths:` (Qwen Code, Claude Code); Cursor's
 * `.cursor/rules/*.mdc` uses `globs:`. Both keys are read in both folders.
 * Accepted forms: an inline list (`paths: ["*.sql", "db/**"]`), a
 * comma-separated value (`globs: *.ts, *.tsx`) and a YAML block list
 * (`paths:` followed by `- "*.sql"` lines).
 */

const frontmatter = /^﻿?---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/;
/** A rule never names more patterns than this; a longer list is cut. */
const maxPatterns = 32;

/** The glob patterns a rule is scoped to; empty when the rule names none. */
export function rulePathPatterns(content: string): string[] {
  const match = frontmatter.exec(content);
  if (!match) return [];
  const lines = (match[1] ?? "").split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const key = /^(?:paths|globs)\s*:\s*(.*)$/i.exec(lines[i]!);
    if (!key) continue;
    const value = key[1]!.replace(/\s+#.*$/, "").trim();
    if (value) { out.push(...splitList(value)); continue; }
    for (let j = i + 1; j < lines.length; j++) {
      const item = /^\s*-\s*(.*)$/.exec(lines[j]!);
      if (!item) { if (lines[j]!.trim() === "") continue; break; }
      out.push(unquote(item[1]!.replace(/\s+#.*$/, "").trim()));
    }
  }
  return [...new Set(out.filter(pattern => pattern.length > 0))].slice(0, maxPatterns);
}

/** The rule text without its frontmatter. */
export function ruleBody(content: string): string {
  const match = frontmatter.exec(content);
  return (match ? content.slice(match[0].length) : content.replace(/^﻿/, "")).trim();
}

/** Splits on commas outside `{...}`, so `*.{ts,tsx}` stays one pattern. */
function splitList(value: string): string[] {
  const inner = /^\[(.*)\]$/.exec(value)?.[1] ?? value;
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of inner) {
    if (char === "{") depth++;
    else if (char === "}") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) { parts.push(current); current = ""; continue; }
    current += char;
  }
  parts.push(current);
  return parts.map(part => unquote(part.trim()));
}

function unquote(text: string): string {
  return /^(["']).*\1$/.test(text) && text.length >= 2 ? text.slice(1, -1) : text;
}
