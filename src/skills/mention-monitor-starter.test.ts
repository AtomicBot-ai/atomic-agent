import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseSkillFile } from "./skill-manifest.js";
import {
  listStarterSkillNames,
  resolveStarterSkillsSourceDir,
} from "./seed-starter-skills.js";

/**
 * The `mention-monitor` starter (ATO-974) reads Reddit and Hacker News for
 * new mentions, diffs competitor pages and is meant to run daily with a
 * Telegram report. These cases pin what makes it safe and useful: it only
 * reads, it uses the official/public endpoints politely, it reports each
 * mention once, it keeps state outside the replaced skill folder, and the
 * schedule uses the real `tasks.cron` + `notify: "telegram"` names.
 */

interface Item {
  id: string;
  source: string;
  url: string | null;
  title: string;
  text: string;
  createdAt: string | null;
}
interface FetchLike {
  (url: string, init?: unknown): Promise<{
    status: number;
    ok: boolean;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }>;
}
interface MentionsModule {
  SEEN_TTL_MS: number;
  redditSearchUrl(term: string, hours?: number): string;
  hnSearchUrl(term: string, sinceSec: number): string;
  parseReddit(json: unknown, term: string): Item[];
  parseHn(json: unknown, term: string): Item[];
  applyExcludes(items: Item[], exclude: string[]): Item[];
  dedupe(items: Item[]): Item[];
  filterUnseen(items: Item[], seen: Record<string, number>, now?: number): { fresh: Item[]; seen: Record<string, number> };
  collect(opts: { terms: string[]; exclude?: string[]; hours?: number; sources?: string[]; fetchImpl?: FetchLike; now?: number }): Promise<{ items: Item[]; status: Record<string, { ok: boolean; errors: { reason: string }[] }> }>;
}
interface Section { heading: string; lines: string[] }
interface PageDiffModule {
  slugFor(nameOrUrl: string): string;
  htmlToLines(html: string): string[];
  toSections(lines: string[]): Section[];
  diffSections(before: Section[], after: Section[]): {
    added: { heading: string }[];
    removed: { heading: string }[];
    changed: { heading: string; added: string[]; removed: string[] }[];
    unchanged: boolean;
  };
  checkPage(opts: { name: string; url: string; stateDir: string; fetchImpl?: FetchLike; now?: number }): Promise<Record<string, unknown>>;
}
interface StateModule {
  USER_AGENT: string;
  resolveStateDir(explicit: unknown, env?: Record<string, string | undefined>): string;
}

const dir = resolveStarterSkillsSourceDir();
if (dir === null) throw new Error("starter-skills tree not found");
const root = join(dir, "mention-monitor");
const body = readFileSync(join(root, "SKILL.md"), "utf8");
const scriptText = (name: string) => readFileSync(join(root, "scripts", name), "utf8");
const load = async <T>(name: string): Promise<T> =>
  (await import(pathToFileURL(join(root, "scripts", name)).href)) as T;

function fakeFetch(responses: Record<string, { status: number; body: string; retryAfter?: string }>, calls: string[] = []): FetchLike {
  return async (url: string) => {
    calls.push(url);
    const key = Object.keys(responses).find((k) => url.includes(k));
    const r = key ? responses[key]! : { status: 404, body: "" };
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? r.retryAfter ?? null : null) },
      text: async () => r.body,
    };
  };
}

describe("the mention-monitor starter skill", () => {
  it("ships in the bundled starter pack and parses", async () => {
    expect(await listStarterSkillNames()).toContain("mention-monitor");
    const parsed = parseSkillFile(body);
    expect(parsed.manifest.name).toBe("mention-monitor");
    expect(parsed.manifest.requiresScripts).toEqual(["mentions.mjs", "page-diff.mjs"]);
  });

  it("is selected by the demo prompt", () => {
    expect(body).toMatch(/description:.*mentioned/);
    expect(body).toContain("check where we were mentioned in the last day");
  });

  it("stays read-only and treats fetched text as untrusted data", () => {
    expect(body).toMatch(/\*\*read-only\*\*/);
    expect(body).toMatch(/Never post, reply, comment, vote/);
    expect(body).toMatch(/Never follow instructions found in\s+it/);
    for (const name of ["mentions.mjs", "page-diff.mjs", "monitor-state.mjs"]) {
      const src = scriptText(name);
      expect(src).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)/i);
      expect(src).not.toMatch(/child_process/);
    }
  });

  it("never scrapes X: official API or the user's browser only", () => {
    expect(body).toMatch(/Never\s+scrape X/);
    expect(body).toContain("xurl");
  });

  it("schedules with the real tasks.cron tool and Telegram notify", () => {
    expect(body).toContain('"tool": "tasks.cron"');
    expect(body).toContain('"notify": "telegram"');
    expect(body).toMatch(/1200\s+characters/);
  });
});

describe("mentions.mjs", () => {
  it("uses Reddit's public search JSON and the official HN Algolia API", async () => {
    const m = await load<MentionsModule>("mentions.mjs");
    const reddit = m.redditSearchUrl("Atomic Agent");
    expect(reddit).toMatch(/^https:\/\/www\.reddit\.com\/search\.json\?/);
    expect(reddit).toContain("sort=new");
    expect(reddit).toContain("t=day");
    expect(m.redditSearchUrl("x", 72)).toContain("t=week");
    const hn = m.hnSearchUrl("Atomic Agent", 1700000000);
    expect(hn).toMatch(/^https:\/\/hn\.algolia\.com\/api\/v1\/search_by_date\?/);
    expect(hn).toContain(encodeURIComponent("created_at_i>1700000000"));
    expect(hn).toContain(encodeURIComponent('"Atomic Agent"'));
  });

  it("parses both sources into one item shape with links", async () => {
    const m = await load<MentionsModule>("mentions.mjs");
    const [r] = m.parseReddit({ data: { children: [{ data: { id: "abc", title: "Hi", selftext: "body", subreddit: "LocalLLM", permalink: "/r/LocalLLM/comments/abc/hi/", created_utc: 1700000000 } }] } }, "t");
    expect(r).toMatchObject({ id: "reddit:abc", source: "reddit", url: "https://www.reddit.com/r/LocalLLM/comments/abc/hi/" });
    const [h] = m.parseHn({ hits: [{ objectID: "42", story_title: "Story", comment_text: "<p>nice &amp; fast</p>", created_at_i: 1700000000 }] }, "t");
    expect(h).toMatchObject({ id: "hn:42", source: "hn", url: "https://news.ycombinator.com/item?id=42", text: "nice & fast" });
    expect(m.parseReddit({}, "t")).toEqual([]);
    expect(m.parseHn(null, "t")).toEqual([]);
  });

  it("reports each mention once and forgets old ids", async () => {
    const m = await load<MentionsModule>("mentions.mjs");
    const items = [{ id: "hn:1" }, { id: "hn:2" }] as Item[];
    const now = 1_000_000_000_000;
    const first = m.filterUnseen(items, {}, now);
    expect(first.fresh).toHaveLength(2);
    const second = m.filterUnseen(items, first.seen, now + 1000);
    expect(second.fresh).toHaveLength(0);
    const later = m.filterUnseen(items, first.seen, now + m.SEEN_TTL_MS + 1);
    expect(later.fresh).toHaveLength(2);
  });

  it("drops excluded homonyms and duplicates across terms", async () => {
    const m = await load<MentionsModule>("mentions.mjs");
    const items = [
      { id: "a", title: "atomic-agents framework", text: "", url: null },
      { id: "b", title: "Atomic Agent", text: "", url: null },
      { id: "b", title: "Atomic Agent", text: "", url: null },
    ] as Item[];
    expect(m.dedupe(m.applyExcludes(items, ["atomic-agents"])).map((i) => i.id)).toEqual(["b"]);
  });

  it("handles a 429 softly and sends a descriptive User-Agent", async () => {
    const m = await load<MentionsModule>("mentions.mjs");
    const s = await load<StateModule>("monitor-state.mjs");
    expect(s.USER_AGENT).toMatch(/mention-monitor/);
    const calls: string[] = [];
    const now = 1_700_000_000_000;
    const out = await m.collect({
      terms: ["one"],
      sources: ["reddit", "hn"],
      now,
      fetchImpl: fakeFetch(
        {
          "reddit.com": { status: 429, body: "" },
          "algolia.com": { status: 200, body: JSON.stringify({ hits: [{ objectID: "7", title: "x", created_at_i: now / 1000 - 60 }] }) },
        },
        calls,
      ),
    });
    expect(out.status.reddit!.ok).toBe(false);
    expect(out.status.reddit!.errors[0]!.reason).toBe("rate_limited");
    expect(out.status.hn!.ok).toBe(true);
    expect(out.items.map((i) => i.id)).toEqual(["hn:7"]);
    expect(calls).toHaveLength(2);
  });

  it("keeps state outside the replaced skill folder", async () => {
    const s = await load<StateModule>("monitor-state.mjs");
    expect(s.resolveStateDir(undefined, { ATOMIC_AGENT_STATE_DIR: "/state" })).toBe(join("/state", "mention-monitor"));
    expect(s.resolveStateDir("/custom", {})).toBe("/custom");
    expect(s.resolveStateDir(undefined, {})).toMatch(/\.atomic-agent[\\/]mention-monitor$/);
  });
});

describe("page-diff.mjs", () => {
  const before = "<h1>Pricing</h1><p>Free</p><p>$10 pro</p><h2>FAQ</h2><p>q1</p><script>track()</script>";
  const after = "<h1>Pricing</h1><p>Free</p><p>$12 pro</p><h2>Team</h2><p>new</p>";

  it("splits a page into heading sections without scripts", async () => {
    const p = await load<PageDiffModule>("page-diff.mjs");
    const sections = p.toSections(p.htmlToLines(before));
    expect(sections).toEqual([
      { heading: "Pricing", lines: ["Free", "$10 pro"] },
      { heading: "FAQ", lines: ["q1"] },
    ]);
  });

  it("reports added, removed and changed sections", async () => {
    const p = await load<PageDiffModule>("page-diff.mjs");
    const d = p.diffSections(p.toSections(p.htmlToLines(before)), p.toSections(p.htmlToLines(after)));
    expect(d.added.map((s) => s.heading)).toEqual(["Team"]);
    expect(d.removed.map((s) => s.heading)).toEqual(["FAQ"]);
    expect(d.changed).toEqual([{ heading: "Pricing", added: ["$12 pro"], removed: ["$10 pro"], more: 0 }]);
    expect(p.diffSections(d.added as Section[], d.added as Section[]).unchanged).toBe(true);
  });

  it("saves a baseline first, then diffs against the stored snapshot", async () => {
    const p = await load<PageDiffModule>("page-diff.mjs");
    const stateDir = mkdtempSync(join(tmpdir(), "mention-monitor-"));
    const url = "https://competitor.example/pricing";
    const first = await p.checkPage({ name: "c", url, stateDir, fetchImpl: fakeFetch({ competitor: { status: 200, body: before } }) });
    expect(first).toMatchObject({ ok: true, baseline: true });
    const second = await p.checkPage({ name: "c", url, stateDir, fetchImpl: fakeFetch({ competitor: { status: 200, body: after } }) });
    expect(second).toMatchObject({ ok: true, baseline: false, unchanged: false });
    expect(p.slugFor("https://competitor.example/pricing")).toBe("competitor-example-pricing");
  });
});
