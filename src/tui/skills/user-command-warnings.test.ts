import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UserCommand } from "../../plugins/user-commands.js";
import { shownPath, userCommandWarnings } from "./user-command-warnings.js";

const home = join("/", "home", "me");
const work = join(home, "proj");
const command = (name: string, file: string): UserCommand => ({
  name,
  source: "project",
  description: name,
  file,
  dir: join(work, ".claude", "commands"),
});

/** ATO-2773: say which own command file did not load, and why. */
describe("userCommandWarnings", () => {
  it("flags a command named like a built-in or one of its aliases", () => {
    const help = join(work, ".claude", "commands", "help.md");
    const exit = join(work, ".claude", "commands", "exit.md");
    const ship = join(work, ".claude", "commands", "ship.md");
    const warnings = userCommandWarnings(
      { commands: [command("help", help), command("exit", exit), command("ship", ship)], problems: [] },
      work,
      home,
    );
    expect(warnings.map(w => w.text)).toEqual([
      `Own command ${join(".claude", "commands", "help.md")} skipped: same name as built-in /help, rename the file.`,
      `Own command ${join(".claude", "commands", "exit.md")} skipped: same name as built-in /exit, rename the file.`,
    ]);
  });

  it("words a skipped file and a half-read one differently, with a stable key", () => {
    const file = join(home, ".atomic-agent", "commands", "deploy.md");
    const problems = [
      { file, reason: "could not parse front matter at line 3, so its description and argument hint are ignored", skipped: false },
      { file, reason: "larger than 128 KiB", skipped: true },
    ];
    const first = userCommandWarnings({ commands: [], problems }, work, home);
    expect(first.map(w => w.text)).toEqual([
      `Own command ${join("~", ".atomic-agent", "commands", "deploy.md")}: could not parse front matter at line 3, so its description and argument hint are ignored.`,
      `Own command ${join("~", ".atomic-agent", "commands", "deploy.md")} skipped: larger than 128 KiB.`,
    ]);
    expect(userCommandWarnings({ commands: [], problems }, work, home).map(w => w.key)).toEqual(first.map(w => w.key));
    expect(new Set(first.map(w => w.key)).size).toBe(2);
  });

  it("shows a path outside the project and the home folder in full", () => {
    const elsewhere = join("/", "srv", "commands", "x.md");
    expect(shownPath(elsewhere, work, home)).toBe(elsewhere);
  });
});
