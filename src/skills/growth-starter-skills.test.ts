import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseSkillFile } from "./skill-manifest.js";
import {
  listStarterSkillNames,
  resolveStarterSkillsSourceDir,
} from "./seed-starter-skills.js";

/**
 * The growth starters (ATO-977): lead research, email drafts, landing
 * page review and ad copy. These cases pin the limits an edit must not
 * soften: no LinkedIn or X scraping and GDPR-safe contacts, drafts that
 * never send, findings tied to evidence, and ad lengths checked by a
 * script rather than by eye.
 */
const dir = resolveStarterSkillsSourceDir();
if (dir === null) throw new Error("starter-skills tree not found");
const read = (name: string) => readFileSync(join(dir, name, "SKILL.md"), "utf8");

describe("growth starter skills ship and parse", () => {
  for (const name of ["lead-research", "email-drafts", "landing-cro-review", "ad-copy"]) {
    it(name, async () => {
      expect(await listStarterSkillNames()).toContain(name);
      const body = read(name);
      expect(parseSkillFile(body).manifest.name).toBe(name);
      expect(body).not.toMatch(/[—–]/);
    });
  }
});

describe("the lead-research starter skill", () => {
  const body = read("lead-research");

  it("never scrapes LinkedIn or X", () => {
    expect(body).toMatch(/description:.*never scrapes LinkedIn or X/);
    expect(body).toMatch(/\*\*No LinkedIn, no X \(Twitter\) scraping\.\*\*/);
  });

  it("keeps to sourced business contact data and opt-outs", () => {
    expect(body).toMatch(/\*\*Business contact data only\.\*\*/);
    expect(body).toMatch(/special categories/);
    expect(body).toMatch(/\*\*Do not guess personal email addresses\.\*\*/);
    expect(body).toMatch(/\*\*Every row has a source\.\*\*/);
    expect(body).toMatch(/\*\*Honour opt-outs\.\*\*/);
    expect(body).toMatch(/source_url,collected_at/);
  });

  it("uses Apify only with the user's own key", () => {
    expect(body).toMatch(/Apify, only with the user's own key/);
  });
});

describe("the email-drafts starter skill", () => {
  const body = read("email-drafts");

  it("only drafts and never sends", () => {
    expect(body).toMatch(/description:.*never sends/);
    expect(body).toMatch(/## The rule: drafts only, always/);
    expect(body).toMatch(/Do not call `os\.email\.send`/);
    expect(body).toMatch(/Never remove the `--gmail-no-send` flag/);
    expect(body).not.toMatch(/"gmail", "send"/);
  });

  it("drafts Atomic Mail to local files since it cannot save drafts", () => {
    expect(body).toMatch(/### Atomic Mail/);
    expect(body).toMatch(/\.\/drafts\//);
  });
});

describe("the landing-cro-review starter skill", () => {
  const body = read("landing-cro-review");

  it("works from a browser screenshot", () => {
    expect(parseSkillFile(body).manifest.requiresTools).toContain("browser.screenshot");
    expect(body).toMatch(/"fullPage": true/);
  });

  it("ties findings to evidence and promises no results", () => {
    expect(body).toMatch(/Every finding points at evidence/);
    expect(body).toMatch(/Do not promise results/);
    expect(body).toMatch(/never suggest inventing it/);
  });
});

describe("the ad-copy starter skill", () => {
  const body = read("ad-copy");
  const script = join(dir, "ad-copy", "scripts", "check-lengths.mjs");

  it("states Google limits and Meta recommendations", () => {
    expect(body).toMatch(/headline 30, description 90, path 15/);
    expect(body).toMatch(/Always say "recommended" for Meta numbers/);
    expect(parseSkillFile(body).manifest.requiresScripts).toEqual(["check-lengths.mjs"]);
  });

  it("pins the limits in the script", async () => {
    const mod = await import(pathToFileURL(script).href);
    expect(mod.GOOGLE_LIMITS).toEqual({ headlines: 30, descriptions: 90, paths: 15 });
    expect(mod.META_RECOMMENDED).toEqual({ primaryTexts: 125, headlines: 40, descriptions: 30 });
  });

  it("fails Google copy over a hard limit and only warns for Meta", async () => {
    const mod = await import(pathToFileURL(script).href);
    const ok = mod.checkAds({
      google: { headlines: ["a".repeat(30), "b", "c"], descriptions: ["d".repeat(90), "e"], paths: ["f".repeat(15)] },
      meta: { primaryTexts: ["g".repeat(200)] },
    });
    expect(ok.failed).toBe(false);
    expect(ok.lines.some((l: string) => l.startsWith("WARN meta.primaryTexts[0] 200/125"))).toBe(true);

    const long = mod.checkAds({ google: { headlines: ["a".repeat(31), "b", "c"] } });
    expect(long.failed).toBe(true);

    const bang = mod.checkAds({ google: { headlines: ["Try it!", "b", "c"] } });
    expect(bang.failed).toBe(true);

    const few = mod.checkAds({ google: { headlines: ["a", "b"] } });
    expect(few.failed).toBe(true);
  });

  it("counts double-width characters as two for Google", async () => {
    const mod = await import(pathToFileURL(script).href);
    expect(mod.googleLength("abc")).toBe(3);
    expect(mod.googleLength("你好")).toBe(4);
    expect(mod.plainLength("你好")).toBe(2);
  });
});
