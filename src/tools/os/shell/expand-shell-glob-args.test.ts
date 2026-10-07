import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandShellGlobArgs } from "./expand-shell-glob-args.js";

describe("expandShellGlobArgs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-glob-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("expands * for rm with cwd-relative pattern", async () => {
    await writeFile(join(dir, "a.png"), "1", "utf8");
    await writeFile(join(dir, "b.png"), "2", "utf8");
    await writeFile(join(dir, "c.txt"), "3", "utf8");
    const out = expandShellGlobArgs("rm", ["-f", "*.png"], dir);
    expect(out[0]).toBe("-f");
    expect(new Set(out.slice(1))).toEqual(
      new Set([join(dir, "a.png"), join(dir, "b.png")]),
    );
  });

  it("expands a real file glob for rm alongside other argv", async () => {
    await writeFile(join(dir, "a.txt"), "1", "utf8");
    await writeFile(join(dir, "b.txt"), "2", "utf8");
    await writeFile(join(dir, "keep.md"), "3", "utf8");
    const out = expandShellGlobArgs("rm", ["*.txt"], dir);
    expect(new Set(out)).toEqual(
      new Set([join(dir, "a.txt"), join(dir, "b.txt")]),
    );
  });

  it("keeps the pattern verbatim when a glob matches nothing", async () => {
    await writeFile(join(dir, "c.txt"), "3", "utf8");
    const out = expandShellGlobArgs("rm", ["-f", "*.png"], dir);
    expect(out).toEqual(["-f", "*.png"]);
  });

  it("keeps a path-shaped pattern that matches nothing verbatim", () => {
    const out = expandShellGlobArgs("ls", ["./nope/*.png"], dir);
    expect(out).toEqual(["./nope/*.png"]);
  });

  it("passes a bash -c payload containing a URL with ? and / through intact", () => {
    const payload =
      "curl -s 'https://en.wikipedia.org/w/api.php?action=query&prop=revisions&titles=Outer%20Wilds&format=json'";
    const args = ["-c", payload];
    const out = expandShellGlobArgs("bash", args, dir);
    expect(out).toEqual(args);
  });

  it("passes a python3 -c payload containing regex metacharacters through intact", () => {
    const payload = "import re; print(re.findall(r'a?b*c', 'aabbcc'))";
    const args = ["-c", payload];
    const out = expandShellGlobArgs("python3", args, dir);
    expect(out).toEqual(args);
  });

  it("never drops argv for a bash -c payload, so the shell sees its command", () => {
    const args = ["-c", "echo 'https://example.com/x?y=1' > /dev/null"];
    const out = expandShellGlobArgs("bash", args, dir);
    expect(out.length).toBe(args.length);
    expect(out[1]).toBe(args[1]);
  });

  it("does not treat a bare URL argument as a glob", () => {
    const url = "https://example.com/w/api.php?action=query&x=*";
    const out = expandShellGlobArgs("curl", ["-s", url], dir);
    expect(out).toEqual(["-s", url]);
  });

  it("does not expand bare *.py for find", async () => {
    await writeFile(join(dir, "a.py"), "x", "utf8");
    const out = expandShellGlobArgs("find", [".", "-name", "*.py"], dir);
    expect(out).toEqual([".", "-name", "*.py"]);
  });

  it("does not expand flag-like tokens", () => {
    const out = expandShellGlobArgs("rm", ["-f"], dir);
    expect(out).toEqual(["-f"]);
  });

  it("still expands a real path argument for an interpreter without -c", async () => {
    await writeFile(join(dir, "s1.py"), "x", "utf8");
    const out = expandShellGlobArgs("python3", ["./s1*.py"], dir);
    expect(out).toEqual([join(dir, "s1.py")]);
  });

  it("leaves a -c payload alone even when it happens to match real files", async () => {
    // The differential case for the exemption itself: without it, this
    // payload would be rewritten to the matched path, not passed through.
    await mkdir(join(dir, "x"));
    await writeFile(join(dir, "x", "y.txt"), "1", "utf8");
    const args = ["-c", "x/*.txt"];
    expect(expandShellGlobArgs("bash", args, dir)).toEqual(args);
  });

  it("exempts the payload for a path-invoked shell and clustered flags", async () => {
    await mkdir(join(dir, "x"));
    await writeFile(join(dir, "x", "y.txt"), "1", "utf8");
    expect(expandShellGlobArgs("/bin/bash", ["-c", "x/*.txt"], dir)).toEqual([
      "-c",
      "x/*.txt",
    ]);
    expect(expandShellGlobArgs("bash", ["-lc", "x/*.txt"], dir)).toEqual([
      "-lc",
      "x/*.txt",
    ]);
  });

  it("still expands -c for interpreters whose -c checks a file", async () => {
    // perl -c is a syntax check on a script path, not an inline program.
    await writeFile(join(dir, "s1.pl"), "x", "utf8");
    const out = expandShellGlobArgs("perl", ["-c", "./s1*.pl"], dir);
    expect(out).toEqual(["-c", join(dir, "s1.pl")]);
  });
});
