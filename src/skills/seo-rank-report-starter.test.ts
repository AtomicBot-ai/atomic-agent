import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSkillFile } from "./skill-manifest.js";
import {
  listStarterSkillNames,
  resolveStarterSkillsSourceDir,
} from "./seed-starter-skills.js";

/**
 * The `seo-rank-report` starter (ATO-973) keeps keyword positions in a
 * local SQLite file and reports week-over-week moves to Telegram through
 * a `tasks.cron` task. These cases pin what makes it safe and useful: the
 * real scheduling tool and its `notify` value, state kept outside the
 * skill folder (which is replaced on every boot), the source order, the
 * ban on scraping Google result pages, and the script's delta maths.
 */
describe("the seo-rank-report starter skill", () => {
  const dir = resolveStarterSkillsSourceDir();
  if (dir === null) throw new Error("starter-skills tree not found");
  const root = join(dir, "seo-rank-report");
  const body = readFileSync(join(root, "SKILL.md"), "utf8");
  const script = join(root, "scripts", "rank_history.py");

  it("ships in the bundled starter pack and parses", async () => {
    expect(await listStarterSkillNames()).toContain("seo-rank-report");
    const parsed = parseSkillFile(body);
    expect(parsed.manifest.name).toBe("seo-rank-report");
    expect(parsed.manifest.dangerous).toBe(false);
    expect(parsed.manifest.requiresTools).toEqual(
      expect.arrayContaining(["os.shell.run", "tasks.cron", "tasks.list"]),
    );
  });

  it("schedules through tasks.cron with Telegram notify and a weekly default", () => {
    expect(body).toMatch(/"tool": "tasks\.cron"/);
    expect(body).toMatch(/"notify": "telegram"/);
    expect(body).toMatch(/"expression": "0 9 \* \* 1"/);
    expect(body).toMatch(/tasks\.list` first/);
    expect(body).toMatch(/atomic-agent task create --cron/);
  });

  it("keeps state outside the skill folder that is replaced on boot", () => {
    expect(body).toMatch(/~\/\.atomic-agent\/seo-rank-report\//);
    expect(body).toMatch(/replaced on every agent start/);
  });

  it("never passes a ~/ script path to python and uses the Skill directory path", () => {
    // Commands run without a shell, so "~" is never expanded (review of #1310).
    expect(body).not.toMatch(/"args":\s*\[\s*"~\//);
    expect(body).not.toMatch(/python3?"?[^\n]*~\/[^\n]*rank_history\.py/);
    expect(body).toMatch(/`Skill directory:` line/);
    expect(body).toMatch(/"<skill directory>\/scripts\/rank_history\.py", "--state-dir", "<state dir>"/);
  });

  it("offers a saved allow rule for exactly this script before the weekly task", () => {
    const rule = body.indexOf('"commandPrefix": ["python3", "<skill directory>/scripts/rank_history.py"]');
    const cron = body.indexOf('"tool": "tasks.cron"');
    expect(rule).toBeGreaterThan(0);
    expect(cron).toBeGreaterThan(rule);
    expect(body).toMatch(/approval-rules\.json/);
    expect(body).toMatch(/stops at that approval/);
  });

  it("tries free sources before paid ones and never scrapes Google", () => {
    const gsc = body.indexOf("Google Search Console, free");
    const paid = body.indexOf("The user's own paid key");
    expect(gsc).toBeGreaterThan(0);
    expect(paid).toBeGreaterThan(gsc);
    expect(body).toMatch(/mcp\.composio\.COMPOSIO_SEARCH_TOOLS/);
    expect(body).toMatch(/DATAFORSEO_LOGIN/);
    expect(body).toMatch(/\*\*Never scrape Google result pages\*\*/);
    expect(body).toMatch(/Never invent or estimate a position/);
  });

  it("reads the DataForSEO key from the .env file, not the command env", () => {
    const src = readFileSync(script, "utf8");
    expect(src).toMatch(/def read_env_file/);
    expect(src).toMatch(/DATAFORSEO_PASSWORD/);
    expect(src).not.toMatch(/^import (requests|httpx)/m);
  });

  const python = spawnSync("python3", ["--version"]).status === 0;

  it.skipIf(!python)("stores runs and reports week-over-week deltas", () => {
    const tmp = mkdtempSync(join(tmpdir(), "seo-rank-"));
    const db = join(tmp, "h.sqlite");
    const run = (...args: string[]) => {
      const out = spawnSync("python3", ["-I", script, "--db", db, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          ATOMIC_AGENT_STATE_DIR: tmp,
          DATAFORSEO_LOGIN: "",
          DATAFORSEO_PASSWORD: "",
        },
      });
      expect(out.status, out.stderr).toBe(0);
      return JSON.parse(out.stdout);
    };
    try {
      run("record", "--domain", "https://www.Example.com/", "--source", "gsc",
        "--date", "2026-11-02", "--json",
        '[{"keyword":"Local AI Agent","position":8.4},{"keyword":"b","position":null},{"keyword":"c","position":3}]');
      run("record", "--domain", "example.com", "--source", "gsc",
        "--date", "2026-11-09", "--json",
        '[{"keyword":"local ai agent","position":5.1},{"keyword":"b","position":12},{"keyword":"c"}]');
      const report = run("report", "--domain", "example.com");
      expect(report.latest_run).toBe("2026-11-09");
      expect(report.previous_run).toBe("2026-11-02");
      const byKw = Object.fromEntries(
        report.keywords.map((k: { keyword: string }) => [k.keyword, k]),
      );
      expect(byKw["local ai agent"]).toMatchObject({ status: "up", change: 3.3 });
      expect(byKw["b"]).toMatchObject({ status: "new", position: 12 });
      expect(byKw["c"]).toMatchObject({ status: "lost", previous: 3 });

      const noKey = run("fetch-dataforseo", "--domain", "example.com",
        "--keywords-file", join(tmp, "missing.txt"));
      expect(noKey.status).toBe("no_key");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(!python)("finds its state dir from --state-dir or ATOMIC_AGENT_STATE_DIR", () => {
    const tmp = mkdtempSync(join(tmpdir(), "seo-rank-state-"));
    const run = (env: Record<string, string>, ...args: string[]) => {
      const out = spawnSync("python3", ["-I", script, ...args], {
        encoding: "utf8",
        cwd: tmp,
        env: { ...process.env, ATOMIC_AGENT_STATE_DIR: "", ...env },
      });
      expect(out.status, out.stderr).toBe(0);
      return JSON.parse(out.stdout);
    };
    const rec = ["record", "--domain", "example.com", "--source", "gsc",
      "--json", '[{"keyword":"a","position":1}]'];
    try {
      const fromEnv = run({ ATOMIC_AGENT_STATE_DIR: join(tmp, "env") }, ...rec);
      expect(fromEnv.db).toBe(join(tmp, "env", "seo-rank-report", "history.sqlite"));
      const fromFlag = run({ ATOMIC_AGENT_STATE_DIR: join(tmp, "env") },
        "--state-dir", join(tmp, "flag"), ...rec);
      expect(fromFlag.db).toBe(join(tmp, "flag", "seo-rank-report", "history.sqlite"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
