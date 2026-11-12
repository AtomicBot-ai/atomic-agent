import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadProjectInstructions } from "./project-instructions.js";
import { createProjectInstructionsCache } from "./project-instructions-cache.js";
import { ancestorDirs, isSensitive, scopeRank } from "./project-instruction-files.js";

describe("project instruction files", () => {
  it("ranks parent-folder scopes before the workspace root and nested folders", () => {
    expect(["a/b", ".", "..", "a", "../.."].sort((x, y) => scopeRank(x) - scopeRank(y))).toEqual(["../..", "..", ".", "a", "a/b"]);
  });

  it("lists the folders between the repository top and the workspace, outermost first", () => {
    const top = resolve("/r");
    expect(ancestorDirs(join(top, "a", "b"), top)).toEqual([top, join(top, "a")]);
    expect(ancestorDirs(top, top)).toEqual([]);
    expect(ancestorDirs(resolve("/elsewhere"), top)).toEqual([]);
  });

  it("marks credential files and folders as sensitive but not ordinary names", () => {
    for (const path of [".envrc", ".kube/config", "x/.ssh/id_ed25519.pub", ".gnupg/pubring.kbx", "secrets.toml", "my-service-account.json", "kubeconfig.yaml", "a/b.tfstate.backup"]) expect(isSensitive(path)).toBe(true);
    for (const path of ["docs/secrets-policy.md", "accounts.json", "service-notes.md", "envrc.md", "rules/ssh.md"]) expect(isSensitive(path)).toBe(false);
  });
});

describe("instructions from folders above the workspace (ATO-312)", () => {
  let base: string;
  let repo: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "parent-rules-")));
    repo = join(base, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  function put(path: string, text = path) { const target = join(repo, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text); }

  it("loads root rules of every folder up to the repository top, outermost first", () => {
    writeFileSync(join(base, "AGENTS.md"), "OUTSIDE REPO");
    put("AGENTS.md", "ROOT RULE"); put("CLAUDE.md", "@docs/shared.md"); put("docs/shared.md", "SHARED");
    put("sub/AGENTS.md", "SUB RULE"); put("other/AGENTS.md", "SIBLING"); put("sub/inner/AGENTS.md", "INNER");
    const fromSub = loadProjectInstructions(join(repo, "sub"));
    expect(fromSub.instructions.map(r => [r.scope, r.body])).toEqual([
      ["..", "ROOT RULE"], ["..", "@docs/shared.md"], ["..", "SHARED"], [".", "SUB RULE"], ["inner", "INNER"]]);
    expect(fromSub.found).toEqual(expect.arrayContaining(["../AGENTS.md", "../CLAUDE.md", "AGENTS.md", "inner/AGENTS.md"]));
    expect(JSON.stringify(fromSub.instructions)).not.toMatch(/OUTSIDE REPO|SIBLING/);
    mkdirSync(join(repo, "sub/deep"));
    const fromDeep = loadProjectInstructions(join(repo, "sub/deep"));
    expect(fromDeep.instructions.map(r => [r.scope, r.body])).toEqual([
      ["../..", "ROOT RULE"], ["../..", "@docs/shared.md"], ["../..", "SHARED"], ["..", "SUB RULE"]]);
  });

  it("asks trust for parent-folder files like any other discovered file", () => {
    put("AGENTS.md", "ROOT RULE"); put("sub/AGENTS.md", "SUB RULE"); put("sub/CLAUDE.md", "@../AGENTS.md");
    const result = loadProjectInstructions(join(repo, "sub"), undefined, { allow: path => path !== "../AGENTS.md" });
    expect(result.instructions.map(r => r.body)).toEqual(["SUB RULE", "@../AGENTS.md"]);
    expect(result.found).toContain("../AGENTS.md");
  });

  it("keeps the credential, Git-ignore and repository-top guards for parent-folder imports", () => {
    writeFileSync(join(base, "outside.md"), "OUTSIDE");
    put(".gitignore", "private.md\n"); put("private.md", "PRIVATE"); put(".env", "SECRET=1"); put("ok.md", "OK");
    put("CLAUDE.md", "@private.md @.env @../outside.md @ok.md"); mkdirSync(join(repo, "sub"));
    const result = loadProjectInstructions(join(repo, "sub"));
    expect(result.instructions.map(r => r.body)).toEqual(["@private.md @.env @../outside.md @ok.md", "OK"]);
    const text = result.diagnostics.join("\n");
    expect(text).toMatch(/ignored or unclassified instruction import: \.\.\/private\.md/);
    expect(text).toMatch(/sensitive instruction import: \.\.\/\.env/);
    expect(text).toMatch(/external instruction: \.\.\/outside\.md/);
  });

  it("never walks to a repository top that is the home directory", () => {
    put("AGENTS.md", "HOME RULE"); put("sub/AGENTS.md", "SUB RULE");
    const result = loadProjectInstructions(join(repo, "sub"), undefined, { homeDir: repo });
    expect(result.instructions.map(r => r.body)).toEqual(["SUB RULE"]);
  });

  it("spends the budget on the outermost rules first and truncates rather than drops them", () => {
    put("AGENTS.md", "R".repeat(2000)); put("sub/AGENTS.md", "SUB RULE");
    const result = loadProjectInstructions(join(repo, "sub"), undefined, { maxBytes: 1000 });
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0]?.body).toMatch(/^R+\n\[\.\.\. truncated/);
    expect(result.diagnostics.join("\n")).toMatch(/skipped: AGENTS\.md/);
  });

  it("watches parent-folder rule files, present or missing", () => {
    put("AGENTS.md", "ROOT RULE"); put("sub/AGENTS.md", "SUB RULE");
    let loads = 0;
    const cached = createProjectInstructionsCache({ ttlMs: 60_000, now: () => 0, load: (...args) => { loads++; return loadProjectInstructions(...args); } });
    const sub = join(repo, "sub");
    expect(cached(sub).instructions.map(r => r.body)).toEqual(["ROOT RULE", "SUB RULE"]);
    expect(cached(sub).instructions).toHaveLength(2); expect(loads).toBe(1);
    put("AGENTS.md", "ROOT RULE, EDITED");
    expect(cached(sub).instructions[0]?.body).toBe("ROOT RULE, EDITED"); expect(loads).toBe(2);
    put("AGENT.md", "NEW PARENT FILE");
    expect(cached(sub).instructions.map(r => r.body)).toContain("NEW PARENT FILE"); expect(loads).toBe(3);
  });
});
