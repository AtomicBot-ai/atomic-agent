import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_GUARD_TOOLS, GuardRulesSource, parseGuardFile } from "./guard-rules.js";

describe("parseGuardFile (ATO-2111)", () => {
  it("reads an inline tools list, onFailure and the rule text", () => {
    expect(parseGuardFile("---\ntools: [os.shell.run, 'os.http.request']\nonFailure: block\n---\nBlock .env reads.\n")).toEqual({
      rules: "Block .env reads.",
      tools: ["os.shell.run", "os.http.request"],
      onFailure: "block",
    });
  });

  it("reads a dash list, and a file without frontmatter is all rules", () => {
    expect(parseGuardFile("---\ntools:\n  - os.shell.run\n  - os.fs.write\n---\nNo deletes.").tools).toEqual([
      "os.shell.run",
      "os.fs.write",
    ]);
    expect(parseGuardFile("Block .env reads.")).toEqual({ rules: "Block .env reads.", tools: null, onFailure: null });
  });

  it("reads an unclear onFailure as the stricter block", () => {
    expect(parseGuardFile("---\nonFailure: maybe\n---\nx").onFailure).toBe("block");
    expect(parseGuardFile("---\nonFailure: ASK\n---\nx").onFailure).toBe("ask");
  });
});

describe("GuardRulesSource", () => {
  let stateDir: string;
  let project: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "guard-rules-state-"));
    project = mkdtempSync(join(tmpdir(), "guard-rules-project-"));
    mkdirSync(join(project, ".atomic-agent"), { recursive: true });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("warns once per file change when tools: names a tool that never asks", () => {
    const warnings: string[] = [];
    const source = new GuardRulesSource(stateDir, (message) => warnings.push(message));
    writeFileSync(join(stateDir, "guard.md"), "---\ntools: [os.fs.read, os.shell.run, os.fs.grep]\n---\nNo .env.");
    expect([...source.load(undefined)!.tools]).toEqual(["os.fs.read", "os.shell.run", "os.fs.grep"]);
    source.load(undefined);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("os.fs.read, os.fs.grep");
    expect(warnings[0]).not.toContain("os.shell.run");
    expect(warnings[0]).toContain("only see the calls that do ask (a read outside the project)");
    writeFileSync(join(stateDir, "guard.md"), "---\ntools: [os.shell.run]\n---\nNo .env, ever.");
    source.load(undefined);
    expect(warnings).toHaveLength(1);
  });

  it("is off without a file, or with a file that holds no rule", () => {
    const source = new GuardRulesSource(stateDir);
    expect(source.load(project)).toBeNull();
    writeFileSync(join(stateDir, "guard.md"), "---\ntools: [os.shell.run]\n---\n\n");
    expect(source.load(project)).toBeNull();
  });

  it("uses the default tools and ask when the file names none", () => {
    writeFileSync(join(stateDir, "guard.md"), "Block .env reads.");
    const rules = new GuardRulesSource(stateDir).load(undefined)!;
    expect([...rules.tools]).toEqual([...DEFAULT_GUARD_TOOLS]);
    expect(rules.onFailure).toBe("ask");
    expect(rules.sets).toEqual([{ source: "user", rules: "Block .env reads." }]);
  });

  it("a project file adds tools and strictness but never removes them", () => {
    writeFileSync(join(stateDir, "guard.md"), "---\ntools: [os.shell.run]\nonFailure: ask\n---\nBlock .env reads.");
    writeFileSync(join(project, ".atomic-agent", "guard.md"), "---\ntools: [os.web.fetch]\nonFailure: block\n---\nNo pastebin.");
    const rules = new GuardRulesSource(stateDir).load(project)!;
    expect([...rules.tools].sort()).toEqual(["os.shell.run", "os.web.fetch"]);
    expect(rules.onFailure).toBe("block");
    expect(rules.sets.map((s) => s.source)).toEqual(["user", "project"]);
  });

  it("a project ask does not relax a global block, and a project file alone turns it on", () => {
    writeFileSync(join(stateDir, "guard.md"), "---\nonFailure: block\n---\nBlock .env reads.");
    writeFileSync(join(project, ".atomic-agent", "guard.md"), "---\nonFailure: ask\n---\nNo pastebin.");
    expect(new GuardRulesSource(stateDir).load(project)!.onFailure).toBe("block");
    rmSync(join(stateDir, "guard.md"));
    const only = new GuardRulesSource(stateDir).load(project)!;
    expect(only.sets).toEqual([{ source: "project", rules: "No pastebin." }]);
  });

  it("agent.security.guardOnFailure: block makes a failure block, and a file ask cannot loosen it (ATO-2529)", () => {
    writeFileSync(join(stateDir, "guard.md"), "---\nonFailure: ask\n---\nBlock .env reads.");
    expect(new GuardRulesSource(stateDir, undefined, () => "block").load(undefined)!.onFailure).toBe("block");
    expect(new GuardRulesSource(stateDir, undefined, () => "ask").load(undefined)!.onFailure).toBe("ask");
    const broken = new GuardRulesSource(stateDir, undefined, () => {
      throw new Error("no config");
    });
    expect(broken.load(undefined)!.onFailure).toBe("ask");
  });

  it("rereads a file that changed", () => {
    const path = join(stateDir, "guard.md");
    writeFileSync(path, "Rule one.");
    const source = new GuardRulesSource(stateDir);
    expect(source.load(undefined)!.sets[0]!.rules).toBe("Rule one.");
    writeFileSync(path, "Rule two, longer.");
    expect(source.load(undefined)!.sets[0]!.rules).toBe("Rule two, longer.");
  });
});
