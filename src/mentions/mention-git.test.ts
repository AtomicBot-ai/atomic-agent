import { describe, expect, it } from "vitest";
import { GIT_SAFE_PREFIX, changedFilesArgs, createRunGit, diffArgs, gitEnv, logArgs, type ExecFileLike } from "./mention-git.js";

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

  it("keeps diffs to the folder and away from configured programs", () => {
    for (const args of [diffArgs(), logArgs(2), changedFilesArgs()]) {
      expect(args).toEqual(expect.arrayContaining(["--no-ext-diff", "--no-textconv", "--relative"]));
      expect(args.slice(-2)).toEqual(["--", "."]);
    }
  });

  it("drops an inherited GIT_DIR and provider keys from git's environment", () => {
    const env = gitEnv({ PATH: "/bin", GIT_DIR: "/elsewhere/.git", OPENAI_API_KEY: "sk-test" });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });
});
