import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGlobalPathRulesReader, readGlobalPathRules } from "./global-path-rules.js";
import { createPathRulesLoader } from "./session-workspace.js";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "aa-global-rules-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("global path rules in <state dir>/rules (ATO-2443)", () => {
  it("reads only files with paths:/globs:, shown under ~ when inside home", () => {
    const home = temp();
    const rulesDir = join(home, ".atomic-agent", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "sql.md"), "---\npaths: [\"*.sql\"]\n---\nSQL RULE");
    writeFileSync(join(rulesDir, "always.md"), "Always on, not a path rule.");
    writeFileSync(join(rulesDir, "notes.txt"), "---\npaths: [\"*.md\"]\n---\nnot markdown");
    const { rules } = readGlobalPathRules(rulesDir, home);
    expect(rules).toEqual([{ path: "~/.atomic-agent/rules/sql.md", patterns: ["*.sql"], body: "SQL RULE" }]);
  });

  it("is empty when the folder is missing, and rereads after a file changes", () => {
    const home = temp();
    const rulesDir = join(home, "rules");
    let clock = 0;
    const read = createGlobalPathRulesReader(rulesDir, { homeDir: home, now: () => clock, ttlMs: 10 });
    expect(read()).toEqual([]);
    mkdirSync(rulesDir);
    writeFileSync(join(rulesDir, "css.md"), "---\nglobs: *.css\n---\nCSS RULE");
    clock = 100;
    expect(read().map(rule => rule.body)).toEqual(["CSS RULE"]);
  });

  it("local loader: an untrusted project rule stays out, a global rule comes in", () => {
    const home = temp();
    const project = temp();
    mkdirSync(join(project, ".atomic-agent", "rules"), { recursive: true });
    writeFileSync(join(project, ".atomic-agent", "rules", "db.md"), "---\npaths: [\"db/**\"]\n---\nPROJECT RULE");
    const stateDir = join(home, "state");
    mkdirSync(join(stateDir, "rules"), { recursive: true });
    writeFileSync(join(stateDir, "rules", "sql.md"), "---\npaths: [\"*.sql\"]\n---\nGLOBAL RULE");
    const config = { paths: { stateDir, userConfigFile: join(home, "missing-config.json") }, skills: { projectTrust: [] } } as never;
    const rules = createPathRulesLoader(config)({ workingDir: project });
    expect(rules.map(rule => rule.body)).toEqual(["GLOBAL RULE"]);
  });
});
