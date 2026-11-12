import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSkillFile } from "./skill-manifest.js";
import {
  listStarterSkillNames,
  resolveStarterSkillsSourceDir,
} from "./seed-starter-skills.js";

/**
 * The `publish-site` starter (ATO-594) puts a site the agent built on the
 * user's own hosting. Publishing is public, so these cases pin the ask-first
 * rule, the no-force-push rollback path, and the read-only preflight that
 * refuses folders holding keys or tokens.
 */
const dir = resolveStarterSkillsSourceDir();
if (dir === null) throw new Error("starter-skills tree not found");
const skillDir = join(dir, "publish-site");
const body = readFileSync(join(skillDir, "SKILL.md"), "utf8");
const script = join(skillDir, "scripts", "check-site.sh");

describe("the publish-site starter skill", () => {
  it("ships in the bundled starter pack and parses cleanly", async () => {
    expect(await listStarterSkillNames()).toContain("publish-site");
    const parsed = parseSkillFile(body);
    expect(parsed.manifest.name).toBe("publish-site");
    expect(parsed.manifest.dangerous).toBe(true);
    expect(parsed.manifest.requiresTools).toContain("os.shell.run");
    expect(parsed.manifest.requiresScripts).toEqual(["check-site.sh"]);
    expect(parsed.manifest.description).toMatch(/GitHub Pages/);
    expect(parsed.manifest.description).toMatch(/asks first/);
  });

  it("requires a fresh yes before every publish, update and rollback", () => {
    expect(body).toMatch(/A published site is public\. Never publish without an explicit yes/);
    expect(body).toMatch(/Updates, rollbacks and take-downs need their own yes/);
  });

  it("defaults to GitHub Pages through gh and documents the other hosts", () => {
    expect(body).toMatch(/use \*\*GitHub Pages\*\*/);
    expect(body).toMatch(/gh repo create <name> --public/);
    expect(body).toMatch(/wrangler pages deploy/);
    expect(body).toMatch(/netlify deploy --dir/);
  });

  it("rolls back by revert, never by force-push or repo deletion", () => {
    expect(body).toMatch(/git -C <staging> revert --no-edit HEAD/);
    expect(body).toMatch(/Never reset or force-push/);
    expect(body).toMatch(/Never delete the repo unless the user/);
  });

  it("stops at the remote-sync guard instead of working around it", () => {
    expect(body).toMatch(/policy\.git_remote_sync_off/);
  });

  it("runs the preflight and refuses a blocked folder", () => {
    expect(body).toMatch(/script: "check-site\.sh"/);
    expect(body).toMatch(/Never publish a `RESULT: blocked` folder/);
  });
});

describe.skipIf(process.platform === "win32")("publish-site check-site.sh", () => {
  let site: string;

  beforeEach(() => {
    site = mkdtempSync(join(tmpdir(), "publish-site-"));
  });
  afterEach(() => {
    rmSync(site, { recursive: true, force: true });
  });

  function check(folder: string): { code: number | null; out: string } {
    const run = spawnSync("bash", [script, folder], { encoding: "utf8" });
    return { code: run.status, out: run.stdout };
  }

  it("passes a clean site and reports what would go out", () => {
    writeFileSync(join(site, "index.html"), '<link href="style.css">');
    writeFileSync(join(site, "style.css"), "body{}");
    const { code, out } = check(site);
    expect(code).toBe(0);
    expect(out).toMatch(/files: 2/);
    expect(out).toMatch(/RESULT: ok/);
  });

  it("refuses a folder without index.html", () => {
    writeFileSync(join(site, "page.html"), "<p>hi</p>");
    const { code, out } = check(site);
    expect(code).toBe(2);
    expect(out).toMatch(/RESULT: not-a-site/);
  });

  it("blocks key files and token-looking strings", () => {
    writeFileSync(join(site, "index.html"), "<p>hi</p>");
    writeFileSync(join(site, ".env"), "X=1");
    mkdirSync(join(site, "js"));
    writeFileSync(join(site, "js", "app.js"), 'const k = "sk-abcdefghijklmnopqrstuvwx";');
    const { code, out } = check(site);
    expect(code).toBe(1);
    expect(out).toMatch(/BLOCKED: secret-looking file: \.env/);
    expect(out).toMatch(/BLOCKED: file contains a key or token: js\/app\.js/);
    expect(out).toMatch(/RESULT: blocked/);
  });

  it("warns about root-absolute links that break on a sub-path site", () => {
    writeFileSync(join(site, "index.html"), '<script src="/app.js"></script>');
    const { code, out } = check(site);
    expect(code).toBe(0);
    expect(out).toMatch(/WARN: root-absolute link/);
    expect(out).toMatch(/RESULT: warnings/);
  });
});
