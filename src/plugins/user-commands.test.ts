import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listProjectCommandTrustKeys, listUserCommands, renderUserCommand, userCommandDirs, type UserCommandOptions } from "./user-commands.js";
import { projectCommandKey } from "./project-command-trust.js";

let root: string;
let opts: UserCommandOptions;

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "user-commands-"));
  opts = { stateDir: join(root, "state"), workingDir: join(root, "work"), isProjectCommandTrusted: () => true };
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

  it("hides project commands that were not trusted", () => {
    put(join(opts.stateDir, "commands", "commit.md"), "Commit\n");
    put(join(opts.workingDir, ".atomic-agent", "commands", "review.md"), "Review\n");
    const none = { ...opts, isProjectCommandTrusted: () => false };
    const listed = listUserCommands(none);
    expect(listed.commands.map(c => c.name)).toEqual(["commit"]);
    expect(listed.problems).toEqual([
      { file: join(opts.workingDir, ".atomic-agent", "commands", "review.md"), reason: "not trusted yet", skipped: true },
    ]);
    expect(renderUserCommand(none, "review", "")).toBeNull();
  });

  /* ATO-2531: trust is per command file and per text, not for the whole folder. */
  it("loads only the project commands whose exact text was trusted", () => {
    const review = join(opts.workingDir, ".atomic-agent", "commands", "review.md");
    put(review, "Review\n");
    put(join(opts.workingDir, ".claude", "commands", "deploy.md"), "Deploy to prod\n");
    const trusted = new Set([projectCommandKey(opts.workingDir, review, "Review\n")]);
    const some = { ...opts, isProjectCommandTrusted: (key: string) => trusted.has(key) };
    expect(listUserCommands(some).commands.map(c => c.name)).toEqual(["review"]);
    expect(renderUserCommand(some, "deploy", "")).toBeNull();
    expect(renderUserCommand(some, "review", "")).toBe("Review");
    // Edited after the answer: hidden until asked again.
    put(review, "Review and push to main\n");
    expect(listUserCommands(some).commands).toEqual([]);
    expect(renderUserCommand(some, "review", "")).toBeNull();
  });

  it("lets a profile command keep its name when the project one is not trusted", () => {
    put(join(opts.stateDir, "commands", "review.md"), "Profile review\n");
    put(join(opts.workingDir, ".atomic-agent", "commands", "review.md"), "Project review\n");
    const none = { ...opts, isProjectCommandTrusted: () => false };
    expect(renderUserCommand(none, "review", "")).toBe("Profile review");
  });

  it("lists every project command file as a trust key, with forward slashes", () => {
    put(join(opts.workingDir, ".atomic-agent", "commands", "team", "review.md"), "Review\n");
    put(join(opts.workingDir, ".claude", "commands", "review.md"), "Other review\n");
    put(join(opts.stateDir, "commands", "commit.md"), "Commit\n");
    const keys = listProjectCommandTrustKeys(opts.workingDir, opts.stateDir);
    expect(keys.map(k => k.replace(/#[0-9a-f]{16}$/, ""))).toEqual([".atomic-agent/commands/team/review.md", ".claude/commands/review.md"]);
    expect(keys.every(k => /#[0-9a-f]{16}$/.test(k))).toBe(true);
  });

  it("lets a project command win over a profile command with the same name", () => {
    put(join(opts.stateDir, "commands", "review.md"), "Profile review\n");
    put(join(opts.workingDir, ".atomic-agent", "commands", "review.md"), "Project review\n");
    const { commands } = listUserCommands(opts);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ name: "review", source: "project" });
    expect(renderUserCommand(opts, "review", "")).toBe("Project review");
  });

  it("reports a file whose name cannot be a command instead of loading it", () => {
    put(join(opts.stateDir, "commands", "bad name.md"), "x\n");
    const { commands, diagnostics } = listUserCommands(opts);
    expect(commands).toEqual([]);
    expect(diagnostics[0]).toContain("bad name");
  });

  // ATO-2773: these used to be collected and then dropped without a word.
  it("marks a file it skips and one whose front matter it ignores", () => {
    put(join(opts.stateDir, "commands", "bad name.md"), "x\n");
    put(join(opts.stateDir, "commands", "deploy.md"), "---\ndescription: [unclosed\n---\nDeploy it\n");
    const { commands, problems } = listUserCommands(opts);
    expect(commands.map(c => c.name)).toEqual(["deploy"]);
    expect(problems).toEqual([
      expect.objectContaining({ file: join(opts.stateDir, "commands", "bad name.md"), skipped: true }),
      expect.objectContaining({
        file: join(opts.stateDir, "commands", "deploy.md"),
        skipped: false,
        reason: expect.stringMatching(/^could not parse front matter at line \d+, so its description/),
      }),
    ]);
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
    expect(renderUserCommand(opts, "REVIEW", 'src/a.ts "error paths"')).toBe(
      'Review src/a.ts focusing on error paths.\nAll: src/a.ts "error paths"\nSee @docs/notes.md and @src/a.ts',
    );
  });

  it("appends the arguments when the body has no placeholder", () => {
    put(join(opts.stateDir, "commands", "fix.md"), "Fix the failing test.\n");
    expect(renderUserCommand(opts, "fix", "parser")).toBe("Fix the failing test.\n\nARGUMENTS: parser");
  });

  it("returns null for a name no user command has, so plugin commands get their turn", () => {
    expect(renderUserCommand(opts, "tools:review", "")).toBeNull();
  });
});
