import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GIT_SAFE_PREFIX, changedFilesArgs, gitSafePrefix, createRunGit, diffArgs, gitEnv, logArgs, type ExecFileLike } from "./mention-git.js";

describe("mention git", () => {
  it("puts the fsmonitor-off prefix before every subcommand and keeps a cut answer", async () => {
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const exec: ExecFileLike = (_file, args, options, callback) => {
      calls.push({ args, env: options.env });
      const err = Object.assign(new Error("too much"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
      callback(args.includes("log") ? err : null, "out");
      return undefined;
    };
    const git = createRunGit(exec);
    expect(await git("/w", diffArgs())).toEqual({ text: "out", cut: false });
    expect(await git("/w", logArgs(3))).toEqual({ text: "out", cut: true });
    for (const call of calls) expect(call.args.slice(0, GIT_SAFE_PREFIX.length)).toEqual([...GIT_SAFE_PREFIX]);
    expect(GIT_SAFE_PREFIX).toContain("core.fsmonitor=false");
  });

  it("covers every setting the desktop hardened in ATO-2532", () => {
    expect(gitSafePrefix("darwin")).toEqual([
      "--no-pager", "--no-optional-locks",
      "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
      "-c", "core.hooksPath=/dev/null", "-c", "log.showSignature=false", "-c", "protocol.ext.allow=never",
    ]);
    expect(gitSafePrefix("win32")).toContain("core.hooksPath=NUL");
  });

  it("keeps diffs to the folder and away from configured programs", () => {
    for (const args of [diffArgs(), logArgs(2), changedFilesArgs()]) {
      expect(args).toEqual(expect.arrayContaining(["--no-ext-diff", "--no-textconv", "--relative"]));
      expect(args.slice(-2)).toEqual(["--", "."]);
    }
  });

  it("names git log's format, so a repo's format.pretty cannot ask for %G?", () => {
    expect(logArgs(1).slice(0, 4)).toEqual(["log", "-n1", "--date=iso", "--pretty=medium"]);
  });

  it.skipIf(process.platform === "win32")("@git:N never runs the repo's gpg.program (real git)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "mention-git-gpg-"));
    try {
      const marker = join(repo, "gpg-ran");
      const gpg = join(repo, "evil-gpg.sh");
      writeFileSync(gpg, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
      chmodSync(gpg, 0o755);
      const git = (args: string[], input?: string): string =>
        execFileSync("git", args, { cwd: repo, encoding: "utf8", input, env: gitEnv() }).trim();
      git(["init", "-q"]);
      git(["config", "format.pretty", "%H %G?"]);
      git(["config", "gpg.program", gpg]);
      writeFileSync(join(repo, "a.txt"), "a\n");
      git(["add", "a.txt"]);
      const tree = git(["write-tree"]);
      const commit = git(["hash-object", "-t", "commit", "-w", "--stdin"], [
        `tree ${tree}`,
        "author a <a@b> 0 +0000",
        "committer a <a@b> 0 +0000",
        "gpgsig -----BEGIN PGP SIGNATURE-----",
        " ",
        " abc",
        " -----END PGP SIGNATURE-----",
        "",
        "signed",
        "",
      ].join("\n"));
      git(["update-ref", "HEAD", commit]);
      // The control: the same call without the named format runs it.
      const unsafe = logArgs(1).filter((a) => a !== "--pretty=medium");
      try {
        execFileSync("git", [...GIT_SAFE_PREFIX, ...unsafe], { cwd: repo, env: gitEnv(), stdio: "ignore" });
      } catch {
        // git may fail after gpg did; only the marker matters.
      }
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);
      await createRunGit()(repo, logArgs(1)).catch(() => undefined);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("drops an inherited GIT_DIR and provider keys from git's environment", () => {
    const env = gitEnv({ PATH: "/bin", GIT_DIR: "/elsewhere/.git", OPENAI_API_KEY: "sk-test" });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });
});
