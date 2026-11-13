// Competitor page watch: fetch a page, reduce it to plain text split into
// sections by its headings, compare with the snapshot saved last time and
// report which sections were added, removed or changed. Only GET requests.
//
// Usage:
//   page-diff.mjs --url https://example.com/pricing [--name example-pricing] [--save-config] [--peek] [--state-dir DIR]
//   page-diff.mjs            (checks every page in <state>/config.json "pages": [{ "name", "url" }])
// First run of a page saves a baseline and reports `baseline: true`.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseArgs, politeGet, readJson, resolveStateDir, writeJson } from "./monitor-state.mjs";

const MAX_LINES_PER_SECTION = 8;
const MAX_LINE_CHARS = 200;

/** Page name to a safe snapshot file name. */
export function slugFor(nameOrUrl) {
  const slug = String(nameOrUrl)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug.length > 0 ? slug : "page";
}

/**
 * HTML to text lines. Headings become `# ` lines so sections can be found;
 * block elements become line breaks; scripts, styles and other markup go.
 */
export function htmlToLines(html) {
  const text = String(html)
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi, (_m, inner) => `\n# ${inner.replace(/<[^>]+>/g, " ")}\n`)
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/section|\/article|\/h[4-6]|\/header|\/footer)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0 && line !== "#");
}

/** Group lines under the nearest heading above them; text before any heading is "(top)". */
export function toSections(lines) {
  const sections = [];
  let current = { heading: "(top)", lines: [] };
  const counts = new Map();
  for (const line of lines) {
    if (line.startsWith("# ")) {
      if (current.lines.length > 0 || current.heading !== "(top)") sections.push(current);
      const base = line.slice(2);
      const n = (counts.get(base) ?? 0) + 1;
      counts.set(base, n);
      current = { heading: n === 1 ? base : `${base} (${n})`, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0 || current.heading !== "(top)") sections.push(current);
  return sections;
}

const cut = (line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line);

/** Section-level diff between two snapshots ({ heading, lines }[]). */
export function diffSections(before, after) {
  const old = new Map(before.map((s) => [s.heading, s.lines]));
  const now = new Map(after.map((s) => [s.heading, s.lines]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [heading, lines] of now) {
    if (!old.has(heading)) {
      added.push({ heading, lines: lines.slice(0, MAX_LINES_PER_SECTION).map(cut) });
      continue;
    }
    const prev = old.get(heading);
    const prevSet = new Set(prev);
    const nowSet = new Set(lines);
    const plus = lines.filter((l) => !prevSet.has(l));
    const minus = prev.filter((l) => !nowSet.has(l));
    if (plus.length > 0 || minus.length > 0) {
      changed.push({
        heading,
        added: plus.slice(0, MAX_LINES_PER_SECTION).map(cut),
        removed: minus.slice(0, MAX_LINES_PER_SECTION).map(cut),
        more: Math.max(0, plus.length - MAX_LINES_PER_SECTION) + Math.max(0, minus.length - MAX_LINES_PER_SECTION),
      });
    }
  }
  for (const heading of old.keys()) if (!now.has(heading)) removed.push({ heading });
  return { added, removed, changed, unchanged: added.length + removed.length + changed.length === 0 };
}

export async function checkPage({ name, url, stateDir, peek = false, fetchImpl, now = Date.now() }) {
  const res = await politeGet(url, { accept: "text/html,application/xhtml+xml", ...(fetchImpl ? { fetchImpl } : {}) });
  if (!res.ok) return { name, url, ok: false, status: res.status, reason: res.reason };
  const sections = toSections(htmlToLines(res.text));
  const dir = join(stateDir, "pages");
  const path = join(dir, `${slugFor(name ?? url)}.json`);
  const previous = readJson(path, null);
  if (!peek) writeJson(path, { url, savedAt: new Date(now).toISOString(), sections }, dir);
  if (previous === null || !Array.isArray(previous.sections)) {
    return { name, url, ok: true, baseline: true, sections: sections.length };
  }
  return { name, url, ok: true, baseline: false, since: previous.savedAt ?? null, ...diffSections(previous.sections, sections) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = resolveStateDir(args["state-dir"]);
  const configPath = join(stateDir, "config.json");
  const config = readJson(configPath, {});
  const pages =
    typeof args.url === "string"
      ? [{ name: typeof args.name === "string" ? args.name : args.url, url: args.url }]
      : Array.isArray(config.pages)
        ? config.pages.filter((p) => p && typeof p.url === "string")
        : [];
  if (pages.length === 0) {
    process.stdout.write(`${JSON.stringify({ error: "no_pages", hint: "pass --url or add pages to config.json" })}\n`);
    process.exitCode = 2;
    return;
  }
  if (args["save-config"] === true && typeof args.url === "string") {
    const kept = (Array.isArray(config.pages) ? config.pages : []).filter((p) => p?.url !== args.url);
    writeJson(configPath, { ...config, pages: [...kept, pages[0]] }, stateDir);
  }
  const results = [];
  for (const page of pages) {
    results.push(await checkPage({ name: page.name ?? page.url, url: page.url, stateDir, peek: args.peek === true }));
  }
  process.stdout.write(`${JSON.stringify({ pages: results }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
