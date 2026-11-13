import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseSkillFile } from "./skill-manifest.js";
import {
  listStarterSkillNames,
  resolveStarterSkillsSourceDir,
} from "./seed-starter-skills.js";

/**
 * The `post-drafts` starter (ATO-975) writes a platform-fit post draft and
 * leaves publishing to the human. These cases pin the parts that make it
 * safe and useful: it never posts, it reads subreddit rules before drafting,
 * it uses brand-context.md, it bans long dashes, and its linter enforces the
 * per-platform limits.
 */
describe("the post-drafts starter skill", () => {
  const dir = resolveStarterSkillsSourceDir();
  if (dir === null) throw new Error("starter-skills tree not found");
  const root = join(dir, "post-drafts");
  const body = readFileSync(join(root, "SKILL.md"), "utf8");
  const lintScript = join(root, "scripts", "post-lint.mjs");

  function lint(platform: string, text: string) {
    const out = execFileSync(
      process.execPath,
      [lintScript, "--platform", platform, "--text", text],
      { encoding: "utf8" },
    );
    return JSON.parse(out) as {
      ok: boolean;
      errors: string[];
      warnings: string[];
      stats: Record<string, unknown>;
    };
  }

  it("ships in the bundled starter pack and parses", async () => {
    expect(await listStarterSkillNames()).toContain("post-drafts");
    const { manifest } = parseSkillFile(body);
    expect(manifest.name).toBe("post-drafts");
    expect(manifest.requiresScripts).toEqual([
      "subreddit-rules.mjs",
      "post-lint.mjs",
    ]);
  });

  it("is draft-only and says it never publishes", () => {
    expect(body).toMatch(/description:.*Draft only, never publishes/);
    expect(body).toMatch(/## Draft only: you never publish/);
    expect(body).toMatch(/It never posts, submits, comments, schedules or\s+sends anything/);
    expect(body).toMatch(/The human publishes/);
    expect(body).toMatch(/I have not posted anything/);
  });

  it("fetches subreddit rules and sidebar before drafting", () => {
    expect(body).toMatch(/Never draft a Reddit post before you have read that subreddit's rules/);
    expect(body).toContain("https://www.reddit.com/r/<sub>/about/rules.json");
    expect(body).toContain("https://www.reddit.com/r/<sub>/about.json");
    expect(body).toMatch(/Do not write a draft that breaks a rule/);
    const fetcher = readFileSync(join(root, "scripts", "subreddit-rules.mjs"), "utf8");
    expect(fetcher).toContain("/about/rules.json");
    expect(fetcher).toContain("submit_text");
    expect(fetcher).not.toMatch(/method:\s*["']POST/i);
  });

  it("uses brand-context.md and asks before saving one", () => {
    expect(body).toMatch(/`brand-context.md` in the workspace root/);
    expect(body).toMatch(/~\/\.atomic-agent\/brand-context\.md/);
    expect(body).toMatch(/only after the user says yes/);
  });

  it("reuses plain-writing and bans long dashes", () => {
    expect(body).toMatch(/Load the `plain-writing` starter with `skill.view`/);
    expect(body).toMatch(/zero `—` \(U\+2014\) and zero `–`/);
    const prose = body.replace(/`[^`]*`/g, "");
    expect(prose).not.toMatch(/[—–]/);
  });

  it("documents the per-platform limits", () => {
    expect(body).toMatch(/280 characters per post/);
    expect(body).toMatch(/3,000 characters/);
    expect(body).toMatch(/first 210 characters/);
    expect(body).toMatch(/Title: 80 characters maximum/);
    expect(body).toMatch(/Show HN: /);
    expect(body).toMatch(/Title: 300 characters maximum/);
  });

  it("lint flags long dashes on every platform", () => {
    for (const p of ["x", "linkedin", "hn", "reddit"]) {
      const r = lint(p, "A title\n\nIt works — mostly – fine");
      expect(r.ok).toBe(false);
      expect(r.stats.longDashes).toBe(2);
    }
  });

  it("lint enforces X 280 per post with links weighted 23", () => {
    expect(lint("x", "a".repeat(280)).ok).toBe(true);
    expect(lint("x", "a".repeat(281)).ok).toBe(false);
    const withLink = `${"a".repeat(256)} https://example.com/${"x".repeat(200)}`;
    expect(lint("x", withLink).stats.postLengths).toEqual([280]);
    const thread = lint("x", `first\n---\n${"b".repeat(300)}`);
    expect(thread.stats.posts).toBe(2);
    expect(thread.errors.join(" ")).toMatch(/post 2 is 300\/280/);
  });

  it("lint enforces LinkedIn 3000, HN title 80 and Reddit title 300", () => {
    expect(lint("linkedin", "a".repeat(3000)).ok).toBe(true);
    expect(lint("linkedin", "a".repeat(3001)).ok).toBe(false);
    expect(lint("hn", `${"a".repeat(80)}\n\nhttps://example.com`).ok).toBe(true);
    expect(lint("hn", `${"a".repeat(81)}\n\nhttps://example.com`).ok).toBe(false);
    expect(lint("hn", "Show HN I built a thing\n\nhttps://example.com").ok).toBe(false);
    expect(lint("reddit", `${"a".repeat(300)}\n\nbody`).ok).toBe(true);
    expect(lint("reddit", `${"a".repeat(301)}\n\nbody`).ok).toBe(false);
  });

  it("lint warns on hashtag stacks", () => {
    expect(lint("x", "post #one #two").warnings.join(" ")).toMatch(/2 hashtags/);
    expect(lint("linkedin", "post #a #b #c #d").warnings.join(" ")).toMatch(/4 hashtags/);
    expect(lint("reddit", "Title\n\nbody #tag").warnings.join(" ")).toMatch(/hashtags/);
  });
});
