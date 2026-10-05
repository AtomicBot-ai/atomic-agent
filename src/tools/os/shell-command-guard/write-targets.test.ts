import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shellWriteTargets } from "./write-targets.js";

/**
 * What the approval gate is told a shell command would change (ATO-225):
 * enough to catch a write of a declined file by another route, and
 * never a file the command only reads.
 */
// POSIX paths and shells; the Windows forms resolve against a drive.
describe.skipIf(process.platform === "win32")("shellWriteTargets", () => {
  const cwd = "/work/project";
  const at = (name: string) => join(cwd, name);

  it("names redirect targets, glued or spaced, and not descriptors", () => {
    expect(shellWriteTargets("printf %s привет > test10.txt", cwd)).toEqual([
      at("test10.txt"),
    ]);
    expect(shellWriteTargets("echo hi>>log.txt 2>err.txt", cwd)).toEqual([
      at("log.txt"),
      at("err.txt"),
    ]);
    expect(shellWriteTargets("npm test 2>&1 >&2", cwd)).toEqual([]);
    expect(shellWriteTargets("echo a->b", cwd)).toEqual([]);
  });

  it("reads a nested sh -c line as the line it runs", () => {
    expect(
      shellWriteTargets('sh -c "echo привет > /Users/me/test10.txt"', cwd),
    ).toEqual(["/Users/me/test10.txt"]);
    expect(shellWriteTargets("bash -lc 'rm -f old.txt; touch new.txt'", cwd)).toEqual([
      at("old.txt"),
      at("new.txt"),
    ]);
  });

  it("names what remove, create and move commands act on, and a copy's destination only", () => {
    expect(shellWriteTargets("rm -rf build dist", cwd)).toEqual([
      at("build"),
      at("dist"),
    ]);
    expect(shellWriteTargets("mv draft.txt final.txt", cwd)).toEqual([
      at("draft.txt"),
      at("final.txt"),
    ]);
    expect(shellWriteTargets("cp notes.txt notes.bak", cwd)).toEqual([
      at("notes.bak"),
    ]);
    expect(shellWriteTargets("cat a.txt | tee -a b.txt", cwd)).toEqual([
      at("b.txt"),
    ]);
    expect(shellWriteTargets("sudo sed -i s/a/b/ conf.txt", cwd)).toContain(
      at("conf.txt"),
    );
    expect(shellWriteTargets("dd if=/dev/zero of=disk.img", cwd)).toEqual([
      at("disk.img"),
    ]);
  });

  it("never names a file the command only reads", () => {
    for (const line of [
      "cat test10.txt",
      "grep -n x test10.txt",
      "diff a.txt test10.txt",
      "sed s/a/b/ test10.txt",
      "wc -l < test10.txt",
    ]) {
      expect(shellWriteTargets(line, cwd)).toEqual([]);
    }
    expect(shellWriteTargets("cat test10.txt > copy.txt", cwd)).toEqual([
      at("copy.txt"),
    ]);
  });

  it("resolves against cd, ~ and $HOME", () => {
    expect(shellWriteTargets("cd sub && touch a.txt", cwd)).toEqual([
      join(cwd, "sub", "a.txt"),
    ]);
    expect(shellWriteTargets("echo x > ~/a.txt", cwd)).toEqual([
      join(homedir(), "a.txt"),
    ]);
    expect(shellWriteTargets("echo x > $HOME/b.txt", cwd)).toEqual([
      join(homedir(), "b.txt"),
    ]);
    // A path built at runtime is not a file this can name.
    expect(shellWriteTargets("echo x > $OUT", cwd)).toEqual([]);
  });
});
