// Read-only mention search on Reddit (public search JSON) and Hacker News
// (official Algolia API). Prints one JSON object: the items not reported
// by an earlier run, plus a per-source status. Only GET requests; this
// script never posts, comments or votes.
//
// Usage:
//   mentions.mjs --term "Atomic Agent" [--term atomicagent.io] [--exclude atomic-agents]
//                [--hours 24] [--source reddit|hn] [--peek] [--save-config] [--state-dir DIR]
// Without --term, terms/exclude come from <state>/config.json.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseArgs, politeGet, readJson, resolveStateDir, sleep, snippet, writeJson } from "./monitor-state.mjs";

/** Seen ids are forgotten after this long, so the file stays small. */
export const SEEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function redditSearchUrl(term, hours = 24) {
  const q = encodeURIComponent(`"${term}"`);
  const t = hours <= 24 ? "day" : hours <= 168 ? "week" : "month";
  return `https://www.reddit.com/search.json?q=${q}&sort=new&t=${t}&limit=50&raw_json=1`;
}

export function hnSearchUrl(term, sinceSec) {
  const q = encodeURIComponent(`"${term}"`);
  return `https://hn.algolia.com/api/v1/search_by_date?query=${q}&tags=(story,comment)&numericFilters=${encodeURIComponent(`created_at_i>${sinceSec}`)}&hitsPerPage=50`;
}

export function parseReddit(json, term) {
  const children = json?.data?.children;
  if (!Array.isArray(children)) return [];
  return children
    .map((child) => child?.data)
    .filter((d) => d && typeof d.id === "string")
    .map((d) => ({
      id: `reddit:${d.id}`,
      source: "reddit",
      term,
      title: snippet(d.title, 200),
      text: snippet(d.selftext),
      where: d.subreddit_name_prefixed ?? (d.subreddit ? `r/${d.subreddit}` : "reddit"),
      author: d.author ?? null,
      url: d.permalink ? `https://www.reddit.com${d.permalink}` : d.url ?? null,
      createdAt: typeof d.created_utc === "number" ? new Date(d.created_utc * 1000).toISOString() : null,
      score: typeof d.score === "number" ? d.score : null,
      comments: typeof d.num_comments === "number" ? d.num_comments : null,
    }));
}

export function parseHn(json, term) {
  const hits = json?.hits;
  if (!Array.isArray(hits)) return [];
  return hits
    .filter((h) => h && h.objectID !== undefined)
    .map((h) => {
      const isComment = typeof h.comment_text === "string" && h.comment_text.length > 0;
      return {
        id: `hn:${h.objectID}`,
        source: "hn",
        term,
        title: snippet(h.title ?? h.story_title ?? "", 200),
        text: snippet(isComment ? h.comment_text : h.story_text ?? h.url ?? ""),
        where: isComment ? "HN comment" : "HN story",
        author: h.author ?? null,
        url: `https://news.ycombinator.com/item?id=${h.objectID}`,
        createdAt: typeof h.created_at_i === "number" ? new Date(h.created_at_i * 1000).toISOString() : h.created_at ?? null,
        score: typeof h.points === "number" ? h.points : null,
        comments: typeof h.num_comments === "number" ? h.num_comments : null,
      };
    });
}

/** Drop items whose text contains an excluded phrase (homonyms, other products). */
export function applyExcludes(items, exclude) {
  const needles = exclude.map((e) => e.toLowerCase()).filter((e) => e.length > 0);
  if (needles.length === 0) return items;
  return items.filter((item) => {
    const hay = `${item.title} ${item.text} ${item.url ?? ""}`.toLowerCase();
    return !needles.some((n) => hay.includes(n));
  });
}

/** Same item found by two terms counts once; keep the first. */
export function dedupe(items) {
  const byId = new Map();
  for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()];
}

/** Split into items not seen before, and the updated (pruned) seen map. */
export function filterUnseen(items, seen, now = Date.now()) {
  const next = {};
  for (const [id, at] of Object.entries(seen ?? {})) {
    if (typeof at === "number" && now - at < SEEN_TTL_MS) next[id] = at;
  }
  const fresh = items.filter((item) => next[item.id] === undefined);
  for (const item of fresh) next[item.id] = now;
  return { fresh, seen: next };
}

export async function collect({ terms, exclude = [], hours = 24, sources = ["reddit", "hn"], fetchImpl, now = Date.now() }) {
  const sinceSec = Math.floor(now / 1000) - Math.round(hours * 3600);
  const status = {};
  const items = [];
  for (const source of sources) {
    status[source] = { ok: true, errors: [] };
    for (const [index, term] of terms.entries()) {
      // Reddit asks unauthenticated clients to stay well under one request a second.
      if (source === "reddit" && index > 0) await sleep(2000);
      const url = source === "reddit" ? redditSearchUrl(term, hours) : hnSearchUrl(term, sinceSec);
      const res = await politeGet(url, fetchImpl ? { fetchImpl } : {});
      if (!res.ok) {
        status[source].ok = false;
        status[source].errors.push({ term, status: res.status, reason: res.reason });
        if (res.status === 429) break; // back off for the rest of this run
        continue;
      }
      let json;
      try {
        json = JSON.parse(res.text);
      } catch {
        status[source].ok = false;
        status[source].errors.push({ term, status: res.status, reason: "bad_json" });
        continue;
      }
      const parsed = source === "reddit" ? parseReddit(json, term) : parseHn(json, term);
      const sinceIso = new Date(sinceSec * 1000).toISOString();
      items.push(...parsed.filter((item) => item.createdAt === null || item.createdAt >= sinceIso));
    }
  }
  return { items: dedupe(applyExcludes(items, exclude)), status };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ["term", "exclude", "source"]);
  const stateDir = resolveStateDir(args["state-dir"]);
  const configPath = join(stateDir, "config.json");
  const config = readJson(configPath, {});
  const terms = args.term.length > 0 ? args.term : Array.isArray(config.terms) ? config.terms : [];
  const exclude = args.exclude.length > 0 ? args.exclude : Array.isArray(config.exclude) ? config.exclude : [];
  if (terms.length === 0) {
    process.stdout.write(`${JSON.stringify({ error: "no_terms", hint: "pass --term or save terms with --save-config", configPath })}\n`);
    process.exitCode = 2;
    return;
  }
  if (args["save-config"] === true) writeJson(configPath, { ...config, terms, exclude }, stateDir);
  const hours = Number(args.hours ?? 24);
  const sources = args.source.length > 0 ? args.source.filter((s) => s === "reddit" || s === "hn") : ["reddit", "hn"];
  const { items, status } = await collect({ terms, exclude, hours: Number.isFinite(hours) && hours > 0 ? hours : 24, sources });
  const seenPath = join(stateDir, "seen.json");
  const { fresh, seen } = filterUnseen(items, readJson(seenPath, {}));
  if (args.peek !== true) writeJson(seenPath, seen, stateDir);
  process.stdout.write(
    `${JSON.stringify({ terms, exclude, hours, status, total: items.length, newCount: fresh.length, alreadyReported: items.length - fresh.length, items: fresh }, null, 2)}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
