import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  findShellPathOutsideScope,
  type ShellScopeEnv,
  shellTokens,
} from "./read-scope-shell.js";

const posixOnly = process.platform === "win32";

describe.skipIf(posixOnly)("shell read scope (token check)", () => {
  let work: string;
  // The homes are lexical, off the temp directory: the temp directory is
  // scratch and always in scope, so nothing "outside" may live there.
  const home = "/srv/homes/me";
  const other = "/srv/homes/me/other";
  const someone = "/srv/homes/someone";
  const env: ShellScopeEnv = { home, platform: "linux" };

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "shell-scope-"));
    mkdirSync(join(work, "src"), { recursive: true });
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  const check = (args: Record<string, unknown>, roots: readonly string[] = [work]) =>
    findShellPathOutsideScope(args, { workingDir: work }, roots, env);

  it("refuses a search rooted in someone's home, from a pre-joined line or argv", () => {
    // Another user's home is under the directory homes live in.
    expect(check({ cmd: `grep -rn x ${someone}` })).toBe(someone);
    expect(check({ cmd: "grep", args: ["-rn", "x", someone] })).toBe(someone);
    expect(check({ cmd: "cat", args: [join(other, "notes.txt")] })).toBe(
      join(other, "notes.txt"),
    );
    // A home elsewhere on disk is not this user's area.
    expect(check({ cmd: "grep -rn x /Users/someone" })).toBeNull();
  });

  it("never refuses the OS's own prefixes", () => {
    for (const cmd of [
      "ls /usr/local/bin",
      "cat /etc/hosts",
      "/opt/homebrew/bin/node --version",
      "ls /Applications /Library /System /bin /sbin",
      "echo x 2>/dev/null",
    ]) {
      expect(check({ cmd }), cmd).toBeNull();
    }
  });

  it("refuses a `..` climb that escapes every root and allows one that stays inside", () => {
    const secret = join(other, "notes.txt");
    const climb = relative(work, secret);
    expect(check({ cmd: "cat", args: [climb] })).toBe(secret);
    expect(check({ cmd: `cat ../${join(work.split("/").pop()!, "src/main.ts")}` })).toBeNull();
    // A climb the user made legitimate by naming the target.
    expect(check({ cmd: `cat ${climb}` }, [work, secret])).toBeNull();
    // A climb into a system prefix is the OS's, not wandering.
    expect(check({ cmd: `cat ${relative(work, "/usr/share/x")}` })).toBeNull();
  });

  it("treats the temp directory as scratch: always in scope, by path or by climb", () => {
    for (const path of [
      join(tmpdir(), "helper.py"),
      "/tmp/out.txt",
      "/var/tmp/cache.bin",
    ]) {
      expect(check({ cmd: `python3 ${path}` }), path).toBeNull();
      expect(check({ cmd: "cat", args: [path] }), path).toBeNull();
      expect(check({ cmd: "cat", args: [relative(work, path)] }), path).toBeNull();
    }
  });

  it("checks `cwd`, an `sh -c` body, a `--flag=path` value, a `~` path and a JSON-string argv", () => {
    expect(check({ cmd: "npm test", cwd: other })).toBe(other);
    expect(check({ cmd: "npm test", cwd: "src" })).toBeNull();
    expect(check({ cmd: "sh", args: ["-c", `cat ${other}/notes.txt`] })).toBe(
      join(other, "notes.txt"),
    );
    expect(check({ cmd: "tool", args: [`--dir=${other}`] })).toBe(other);
    expect(check({ cmd: "cat ~/other/notes.txt" })).toBe(join(other, "notes.txt"));
    expect(check({ cmd: "cat", args: `["${other}/a.txt"]` })).toBe(
      join(other, "a.txt"),
    );
  });

  it("leaves everything else alone: the working directory, elsewhere on disk, patterns, URLs", () => {
    for (const args of [
      { cmd: "cat", args: [join(work, "src", "main.ts")] },
      { cmd: "ls", args: ["/Volumes/data"] },
      { cmd: "grep", args: ["/^foo/", "src/main.ts"] },
      { cmd: "curl https://example.com/a/b" },
      { cmd: "sed", args: ["s/a/b/", "src/main.ts"] },
      { cmd: "echo", args: ["and/or", "a..b"] },
    ]) {
      expect(check(args), JSON.stringify(args)).toBeNull();
    }
  });

  it("tokenises cmd, argv and a double-serialised argv alike", () => {
    expect(shellTokens({ cmd: "grep -rn x", args: ["a b", "c"] })).toEqual([
      "grep",
      "-rn",
      "x",
      "a",
      "b",
      "c",
    ]);
    expect(shellTokens({ cmd: "ls", args: '["-la", "src"]' })).toEqual([
      "ls",
      "-la",
      "src",
    ]);
    expect(shellTokens({ cmd: "ls", args: "not json" })).toEqual(["ls"]);
  });
});
