import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listUserCommands, renderUserCommand, userCommandDirs, type UserCommandOptions } from "./user-commands.js";

let root: string;
let opts: UserCommandOptions;

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "user-commands-"));
  opts = { stateDir: join(root, "state"), workingDir: join(root, "work"), projectTrusted: true };
  mkdirSync(opts.workingDir, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("listUserCommands", () => {
  it("loads profile and project commands, nested folders as name:sub", () => {
    put(join(opts.stateDir, "commands", "commit.md"), "---\ndescription: Commit staged work\nargument-hint: <message>\n---\nCommit with $ARGUMENTS\n");
    put(join(opts.workingDir, ".atomic-agent", "commands", "team", "Review.md"), "# Review the diff\nReview $1\n");
    put(join(opts.workingDir, ".claude", "commands", "release.md"), "Cut a release\n");
    const { commands, diagnostics } = listUserCommands(opts);
    expect(diagnostics).toEqual([]);
    expect(commands.map(c => [c.name, c.source, c.description, c.argumentHint ?? null])).toEqual([
      ["team:review", "project", "Review the diff", null],
      ["release", "project", "Cut a release", null],
      ["commit", "profile", "Commit staged work", "<message>"],
    ]);
  });

  it("hides project commands while the folder is not trusted", () => {
    put(join(opts.stateDir, "commands", "commit.md"), "Commit\n");
    put(join(opts.workingDir, ".atomic-agent", "commands", "review.md"), "Review\n");
    const names = listUserCommands({ ...opts, projectTrusted: false }).commands.map(c => c.name);
    expect(names).toEqual(["commit"]);
    expect(renderUserCommand({ ...opts, projectTrusted: false }, "review", "")).toBeNull();
  });

  it("lets a project command win over a profile command with the same name", () => {
    put(join(opts.stateDir, "commands", "review.md"), "Profile review\n");
    put(join(opts.workingDir, ".atomic-agent", "commands", "review.md"), "Project review\n");
    const { commands } = listUserCommands(opts);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ name: "review", source: "project" });
    expect(renderUserCommand(opts, "review", "")?.text).toBe("Project review");
  });

  it("reports a file whose name cannot be a command instead of loading it", () => {
    put(join(opts.stateDir, "commands", "bad name.md"), "x\n");
    const { commands, diagnostics } = listUserCommands(opts);
    expect(commands).toEqual([]);
    expect(diagnostics[0]).toContain("bad name");
  });

  it("does not list the profile folder twice when the working folder is the home of the state folder", () => {
    const home = { ...opts, workingDir: root, stateDir: join(root, ".atomic-agent") };
    expect(userCommandDirs(home).map(d => d.source)).toEqual(["project", "profile"]);
    expect(userCommandDirs(home).filter(d => d.dir === join(root, ".atomic-agent", "commands"))).toHaveLength(1);
  });
});

describe("renderUserCommand", () => {
  it("fills $ARGUMENTS and $1..$9 and turns @{path} into @path", () => {
    put(join(opts.stateDir, "commands", "review.md"), "Review $1 focusing on $2.\nAll: $ARGUMENTS\nSee @{docs/notes.md} and @src/a.ts\n");
    expect(renderUserCommand(opts, "REVIEW", 'src/a.ts "error paths"')?.text).toBe(
      'Review src/a.ts focusing on error paths.\nAll: src/a.ts "error paths"\nSee @docs/notes.md and @src/a.ts',
    );
  });

  it("appends the arguments when the body has no placeholder", () => {
    put(join(opts.stateDir, "commands", "fix.md"), "Fix the failing test.\n");
    expect(renderUserCommand(opts, "fix", "parser")?.text).toBe("Fix the failing test.\n\nARGUMENTS: parser");
  });

  it("cuts shell lines out as slots; arguments used only inside one still count (ATO-2441)", () => {
    put(join(opts.stateDir, "commands", "log.md"), "Summarise:\n!`git log -n $1`\n");
    const rendered = renderUserCommand(opts, "log", "5");
    expect(rendered?.slots.map(s => s.command)).toEqual(["git log -n $1"]);
    expect(rendered?.text).toBe(`Summarise:\n${rendered?.slots[0]?.marker}`);
    expect(rendered?.fillShellLine("git log -n $1")).toBe("git log -n 5");
  });

  it("returns null for a name no user command has, so plugin commands get their turn", () => {
    expect(renderUserCommand(opts, "tools:review", "")).toBeNull();
  });
});
