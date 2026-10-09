import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { instructionImports, loadProjectInstructions } from "./project-instructions.js";

describe("cloud project instructions", () => {
  let base: string;
  let root: string;
  beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "project-rules-"))); root = join(base, "workspace"); mkdirSync(root); });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  function put(path: string, text = path) { const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text); }

  it.each([true, false])("finds all scopes within the boundary (Git=%s)", git => {
    if (git) execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(base, "AGENTS.md"), "PARENT MUST NOT LOAD");
    for (const name of ["AGENTS.md", "AGENT.md", "CLAUDE.md", ".claude/CLAUDE.md", "src/AGENTS.md", "src/deep/.claude/CLAUDE.md", "node_modules/pkg/AGENTS.md", ".git/CLAUDE.md"]) put(name);
    const rules = loadProjectInstructions(root).instructions;
    expect(rules).toHaveLength(6);
    expect(rules.filter(r => r.scope === ".").map(r => r.priority)).toEqual([4, 3, 2, 1]);
    expect(rules.find(r => r.body === "src/deep/.claude/CLAUDE.md")?.scope).toBe("src/deep");
    expect(JSON.stringify(rules)).not.toContain("PARENT MUST NOT LOAD");
  });

  it("uses tracked and nonignored paths, including ignored root instructions", () => {
    execFileSync("git", ["init", "-q", root]);
    put(".gitignore", "AGENTS.md\nignored/\n");
    put("AGENTS.md"); put("ignored/CLAUDE.md"); put("tracked/AGENTS.md"); put("untracked/CLAUDE.md");
    execFileSync("git", ["-C", root, "add", "-f", "tracked/AGENTS.md"]);
    expect(loadProjectInstructions(root).instructions.map(r => r.body).sort()).toEqual(["AGENTS.md", "tracked/AGENTS.md", "untracked/CLAUDE.md"]);
  });

  it("expands relative imports once, reports cycles and skips external imports/symlinks", () => {
    put("CLAUDE.md", "@rules/a.md @rules/a.md @../missing.md @~/personal.md\n`@missing.md`\n```\n@missing.md\n```");
    put("rules/a.md", "@b.md\nFIRST"); put("rules/b.md", "@a.md\nSECOND");
    writeFileSync(join(base, "outside.md"), "OUTSIDE");
    symlinkSync(join(base, "outside.md"), join(root, "AGENT.md"));
    const result = loadProjectInstructions(root);
    expect(result.instructions).toHaveLength(3);
    expect(result.instructions.every(r => r.scope === ".")).toBe(true);
    expect(result.diagnostics.join("\n")).toMatch(/cycle/);
    expect(result.diagnostics.join("\n")).toMatch(/external/);
    expect(result.instructions.some(r => r.body === "OUTSIDE")).toBe(false);
  });

  it("does not expand imports in fences or inline code", () => {
    expect(instructionImports("@real.md `@no.md` ``@also-no.md``\n~~~md\n@no.md\n~~~\n(@last.md)")).toEqual(["real.md", "last.md"]);
  });

  it("fails explicitly on missing internal imports, depth, special files and size", () => {
    put("CLAUDE.md", "@missing.md"); expect(() => loadProjectInstructions(root)).toThrow();
    for (let i = 0; i < 5; i++) put(`rules/${i}.md`, `@${i + 1}.md`);
    put("rules/5.md", "last"); put("CLAUDE.md", "@rules/0.md");
    expect(() => loadProjectInstructions(root)).toThrow(/four hops/);
    put("CLAUDE.md", "x".repeat(1024 * 1024 + 1)); expect(() => loadProjectInstructions(root)).toThrow(/bytes/);
    rmSync(join(root, "CLAUDE.md")); mkdirSync(join(root, "AGENT.md"));
    expect(() => loadProjectInstructions(root)).toThrow(/regular file/);
  });

  it("reflects edits and removals without a cache", () => {
    put("AGENTS.md", "first"); expect(loadProjectInstructions(root).instructions[0]?.body).toBe("first");
    put("AGENTS.md", "second"); expect(loadProjectInstructions(root).instructions[0]?.body).toBe("second");
    rmSync(join(root, "AGENTS.md")); expect(loadProjectInstructions(root).instructions).toEqual([]);
  });
});
