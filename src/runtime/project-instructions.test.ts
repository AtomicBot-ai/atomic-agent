import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { instructionImports, loadProjectInstructions, runGitInWorkspace } from "./project-instructions.js";

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

  it("does not expand imports in indented code blocks", () => {
    expect(instructionImports("Intro\n\n    @code.md\n\n    @still-code.md\nText @real.md\n- item\n    @continued.md")).toEqual(["real.md", "continued.md"]);
  });

  it("skips missing and directory imports with grouped, relative diagnostics", () => {
    const mentions = Array.from({ length: 8 }, (_, i) => `@user${i}`).join(" ");
    put("CLAUDE.md", `Ask @nadya, install @types/node, see @src for code. ${mentions}\nBODY`); mkdirSync(join(root, "src"));
    const result = loadProjectInstructions(root);
    expect(result.instructions.map(r => r.body)).toHaveLength(1);
    const missing = result.diagnostics.filter(d => /missing instruction imports/.test(d));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatch(/and 5 more$/);
    expect(result.diagnostics.join("\n")).toMatch(/non-file instruction: src/);
    expect(result.diagnostics.join("\n")).not.toContain(base);
  });

  it("skips an imported file over the size limit without dropping other rules", () => {
    put("big.md", "x".repeat(1024 * 1024 + 1)); put("CLAUDE.md", "see @big.md"); put("AGENTS.md", "KEEP");
    const result = loadProjectInstructions(root);
    expect(result.instructions.map(r => r.body).sort()).toEqual(["KEEP", "see @big.md"]);
    expect(result.diagnostics.join("\n")).toMatch(/unreadable instruction: big\.md/);
  });

  it.each([true, false])("never imports secrets such as .env (Git=%s)", git => {
    if (git) { execFileSync("git", ["init", "-q", root]); put(".gitignore", "local-notes.md\n"); put("local-notes.md", "IGNORED NOTE"); }
    put(".env", "SECRET=1"); put("deploy.pem", "KEY"); put("CLAUDE.md", "never commit @.env or @deploy.pem; see @local-notes.md");
    const result = loadProjectInstructions(root);
    const bodies = result.instructions.map(r => r.body).join("\n");
    expect(bodies).not.toContain("SECRET=1");
    expect(result.instructions.some(r => r.body === "KEY")).toBe(false);
    if (git) expect(bodies).not.toContain("IGNORED NOTE");
    expect(result.diagnostics.join("\n")).toMatch(/sensitive instruction import: \.env, deploy\.pem/);
  });

  it("falls back to the walk when Git refuses the folder, skipping dependency trees", () => {
    const runGit = () => ({ status: 128, stdout: "", stderr: "fatal: detected dubious ownership in repository at '/x'\n" });
    put("nested/AGENTS.md"); put("dist/AGENTS.md"); put(".venv/lib/CLAUDE.md"); put("vendor/pkg/AGENTS.md");
    const result = loadProjectInstructions(root, undefined, { runGit });
    expect(result.instructions.map(r => r.body)).toEqual(["nested/AGENTS.md"]);
    expect(result.diagnostics.join("\n")).toMatch(/dubious ownership/);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("skips unreadable directories in the walk", () => {
    put("AGENTS.md", "ROOT"); put("locked/AGENTS.md", "LOCKED"); chmodSync(join(root, "locked"), 0o000);
    try {
      const result = loadProjectInstructions(root);
      expect(result.instructions.map(r => r.body)).toEqual(["ROOT"]);
      expect(result.diagnostics.join("\n")).toMatch(/unreadable directories: locked/);
    } finally { chmodSync(join(root, "locked"), 0o755); }
  });

  it("stops the walk and the file/byte budgets with diagnostics instead of failing", () => {
    for (let i = 0; i < 6; i++) put(`d${i}/AGENTS.md`, `rule ${i}`);
    put("AGENTS.md", "ROOT");
    const capped = loadProjectInstructions(root, undefined, { maxEntries: 3 });
    expect(capped.instructions.map(r => r.body)).toContain("ROOT");
    expect(capped.diagnostics.join("\n")).toMatch(/stopped at 3 entries/);
    const files = loadProjectInstructions(root, undefined, { maxFiles: 2 });
    expect(files.instructions).toHaveLength(2);
    expect(files.instructions[0]?.body).toBe("ROOT");
    expect(files.diagnostics.join("\n")).toMatch(/exceed 2 files/);
    const sized = loadProjectInstructions(root, undefined, { maxBytes: 10 });
    expect(sized.instructions.map(r => r.body)).toEqual(["ROOT", "rule 0"]);
    expect(sized.diagnostics.join("\n")).toMatch(/exceed 10 bytes/);
  });

  it("skips deep imports, special files and oversized root files without throwing", () => {
    for (let i = 0; i < 5; i++) put(`rules/${i}.md`, `@${i + 1}.md`);
    put("rules/5.md", "last"); put("CLAUDE.md", "@rules/0.md");
    let result = loadProjectInstructions(root);
    expect(result.instructions.some(r => r.body === "last")).toBe(false);
    expect(result.diagnostics.join("\n")).toMatch(/four hops: rules\/4\.md/);
    put("CLAUDE.md", "x".repeat(1024 * 1024 + 1));
    rmSync(join(root, "AGENTS.md"), { force: true }); mkdirSync(join(root, "AGENTS.md")); put("AGENT.md", "STILL LOADED");
    result = loadProjectInstructions(root);
    expect(result.instructions.map(r => r.body)).toEqual(["STILL LOADED"]);
    expect(result.diagnostics.join("\n")).toMatch(/non-file instruction: AGENTS\.md/);
    expect(result.diagnostics.join("\n")).toMatch(/unreadable instruction: CLAUDE\.md/);
  });

  it("reports a missing workspace instead of throwing", () => {
    const result = loadProjectInstructions(join(base, "gone"));
    expect(result.instructions).toEqual([]);
    expect(result.diagnostics.join("\n")).toMatch(/unavailable/);
  });

  it("spends the byte budget on the root CLAUDE.md and its imports before nested rules", () => {
    put("CLAUDE.md", "ROOT @rules.md"); put("rules.md", "IMPORTED");
    put("a/AGENTS.md", "x".repeat(30)); put("b/AGENTS.md", "y".repeat(30));
    const result = loadProjectInstructions(root, undefined, { maxBytes: 40 });
    expect(result.instructions.map(r => r.body).sort()).toEqual(["IMPORTED", "ROOT @rules.md"]);
    expect(result.diagnostics.join("\n")).toMatch(/exceed 40 bytes/);
  });

  it("classifies all imports with a single git check-ignore per load", () => {
    execFileSync("git", ["init", "-q", root]);
    put(".gitignore", "secret-notes.md\n"); put("secret-notes.md", "HIDDEN");
    put("CLAUDE.md", "@a.md @b.md @secret-notes.md"); put("a.md", "@c.md A"); put("b.md", "B"); put("c.md", "C");
    const calls: string[] = [];
    const result = loadProjectInstructions(root, undefined, { runGit: (dir, args, input) => { calls.push(args[0]!); return runGitInWorkspace(dir, args, input); } });
    expect(calls.filter(c => c === "check-ignore")).toHaveLength(1);
    expect(result.instructions.map(r => r.body).sort()).toEqual(["@a.md @b.md @secret-notes.md", "@c.md A", "B", "C"]);
    expect(result.diagnostics.join("\n")).toMatch(/ignored or unclassified instruction import: secret-notes\.md/);
  });

  it("never imports common credential files", () => {
    const secrets = [".aws/credentials", "credentials.json", "prod.tfvars", ".docker/config.json", "vault.kdbx", ".pypirc", ".git-credentials"];
    for (const path of secrets) put(path, "SECRET");
    put("CLAUDE.md", secrets.map(path => `@${path}`).join(" "));
    const result = loadProjectInstructions(root);
    expect(result.instructions.map(r => r.body).join("\n")).not.toContain("SECRET");
    expect(result.diagnostics.join("\n")).toMatch(/sensitive instruction import: .*and 2 more/);
  });

  it("reflects edits and removals without a cache", () => {
    put("AGENTS.md", "first"); expect(loadProjectInstructions(root).instructions[0]?.body).toBe("first");
    put("AGENTS.md", "second"); expect(loadProjectInstructions(root).instructions[0]?.body).toBe("second");
    rmSync(join(root, "AGENTS.md")); expect(loadProjectInstructions(root).instructions).toEqual([]);
  });
});
