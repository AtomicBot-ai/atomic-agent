import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execWriteTargets, shellWriteTargets } from "./write-targets.js";

/**
 * What the approval gate is told a shell command would change (ATO-225):
 * enough to catch a write of a declined file by another route, and
 * never a file the command only reads or only mentions — a false target
 * is a call refused that the user would have allowed.
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
    expect(shellWriteTargets('echo "<br>" > page.html', cwd)).toEqual([
      at("page.html"),
    ]);
    expect(shellWriteTargets("npm test 2>&1 >&2", cwd)).toEqual([]);
    expect(shellWriteTargets("npm test > /dev/null", cwd)).toEqual([]);
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
    expect(shellWriteTargets("sudo sed -i s/a/b/ conf.txt", cwd)).toEqual([
      at("conf.txt"),
    ]);
    expect(shellWriteTargets("perl -pi -e 's/a/b/' conf.txt", cwd)).toEqual([
      at("conf.txt"),
    ]);
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
      // A flag's value is not a file it changes.
      "touch -r test10.txt",
      // `-M` and `-I` are not `-i`.
      "perl -Mstrict -Ilib script.pl test10.txt",
    ]) {
      expect(shellWriteTargets(line, cwd)).toEqual([]);
    }
    expect(shellWriteTargets("cat test10.txt > copy.txt", cwd)).toEqual([
      at("copy.txt"),
    ]);
  });

  it("reads quoted text as one argument, not as operators or commands", () => {
    for (const line of [
      // A `>` closing a quoted word is not a redirect into the next one.
      'grep -n "<title>" index.html',
      "grep -n '^>' index.html",
      // `|` and `;` inside quotes split nothing.
      'grep -E "error|rm" app.log',
      'git commit -m "Fix it; rm test10.txt later"',
      'echo "a->b"',
      // A multi-line message or script is one argument.
      'git commit -m "Move test10.txt\n\nmv test10.txt done.txt"',
      "python3 -c 'import os\nos.remove(\"x\")'",
    ]) {
      expect(shellWriteTargets(line, cwd)).toEqual([]);
    }
  });

  it("skips heredoc bodies and names only the heredoc's own redirect", () => {
    expect(
      shellWriteTargets("cat > notes.md <<'EOF'\ncp a.txt test10.txt\nrm b.txt\nEOF", cwd),
    ).toEqual([at("notes.md")]);
    expect(
      shellWriteTargets("cat <<-END | wc -l\n\trm test10.txt\n\tEND\ntouch after.txt", cwd),
    ).toEqual([at("after.txt")]);
  });

  it("counts Windows verbs only on Windows", () => {
    expect(shellWriteTargets("move test10.txt done.txt", cwd)).toEqual([]);
    expect(shellWriteTargets("del test10.txt", cwd)).toEqual([]);
    expect(shellWriteTargets("install -m 644 a.txt test10.txt", cwd)).toEqual([]);
  });

  it("resolves against cd, ~ and $HOME, and not past a subshell", () => {
    expect(shellWriteTargets("cd sub && touch a.txt", cwd)).toEqual([
      join(cwd, "sub", "a.txt"),
    ]);
    expect(shellWriteTargets("(cd sub; touch a.txt); touch b.txt", cwd)).toEqual([
      join(cwd, "sub", "a.txt"),
      at("b.txt"),
    ]);
    expect(shellWriteTargets("echo x > ~/a.txt", cwd)).toEqual([
      join(homedir(), "a.txt"),
    ]);
    expect(shellWriteTargets("echo x > $HOME/b.txt", cwd)).toEqual([
      join(homedir(), "b.txt"),
    ]);
    // A path built at runtime is not a file this can name, nor is a
    // relative one after a `cd` it cannot follow.
    expect(shellWriteTargets("echo x > $OUT", cwd)).toEqual([]);
    expect(shellWriteTargets("rm *.log", cwd)).toEqual([]);
    expect(shellWriteTargets('cd "$DIR" && touch a.txt', cwd)).toEqual([]);
  });

  it("names nothing in a line it cannot read", () => {
    for (const line of [
      "echo $(cat list) > out.txt",
      "echo `date` > out.txt",
      "echo ${OUT:-x} > out.txt",
      'echo "unbalanced > out.txt',
    ]) {
      expect(shellWriteTargets(line, cwd)).toEqual([]);
    }
  });
});

describe.skipIf(process.platform === "win32")("execWriteTargets", () => {
  const cwd = "/work/project";

  it("reads a direct exec's argv as it is: a `>` in an argument is text", () => {
    expect(execWriteTargets("echo", ["привет", ">", "test10.txt"], cwd)).toEqual([]);
    expect(execWriteTargets("grep", ["-n", "<title>", "index.html"], cwd)).toEqual([]);
    expect(execWriteTargets("rm", ["-f", "my notes.txt"], cwd)).toEqual([
      join(cwd, "my notes.txt"),
    ]);
  });

  it("reads the line a shell is given with -c", () => {
    expect(
      execWriteTargets("sh", ["-c", "echo привет > /abs/test10.txt"], cwd),
    ).toEqual(["/abs/test10.txt"]);
    // A shell running a script file names nothing.
    expect(execWriteTargets("bash", ["build.sh", "out.txt"], cwd)).toEqual([]);
  });
});
