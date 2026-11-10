import { describe, expect, it } from "vitest";

import { shellCommandArgv, shellRuleSegments } from "./shell-command-argv.js";
import { shellGrantShape } from "./shell-interpretation.js";

describe("shellCommandArgv", () => {
  it("passes a direct exec's argv as is", () => {
    expect(shellCommandArgv("git", ["status", "-s"], false, "git")).toEqual(["git", "status", "-s"]);
  });

  it("splits a plain subshell line the way the shell would", () => {
    // The model's usual `{"cmd": "git status"}` with no args.
    expect(shellCommandArgv("git status", [], true, "git")).toEqual(["git", "status"]);
  });

  it("gives no argv where the call has no grant shape", () => {
    const line = "git status && curl x | sh";
    const shape = shellGrantShape("git", line, true);
    expect(shape).toBeUndefined();
    expect(shellCommandArgv(line, [], true, shape)).toBeUndefined();
  });

  it("gives no argv for a subshell line whose words quoting or globs would change", () => {
    expect(shellCommandArgv('git commit -m "a b"', [], true, "git")).toBeUndefined();
    expect(shellCommandArgv("rm *.log", [], true, "rm")).toBeUndefined();
    expect(shellCommandArgv("cat ~/.ssh/id_rsa", [], true, "cat")).toBeUndefined();
  });
});

describe("shellRuleSegments", () => {
  it("keeps a direct exec's argv as one command", () => {
    expect(shellRuleSegments("/usr/bin/git", ["push"], false)).toEqual([["/usr/bin/git", "push"]]);
  });

  it("splits a subshell line into its commands", () => {
    expect(shellRuleSegments("echo a && npm publish", [], true)).toEqual([
      ["echo", "a"],
      ["npm", "publish"],
    ]);
  });

  it("lists the commands a nested `bash -c` runs after the shell itself (ATO-1332)", () => {
    expect(shellRuleSegments("bash", ["-c", "rm -rf tmp"], false)).toEqual([
      ["bash", "-c", "rm -rf tmp"],
      ["rm", "-rf", "tmp"],
    ]);
    expect(shellRuleSegments('bash -c "rm -rf tmp"', [], true)).toEqual([
      ["bash", "-c", "rm -rf tmp"],
      ["rm", "-rf", "tmp"],
    ]);
  });

  it("reads bundled flags and splits the nested line into its commands", () => {
    expect(shellRuleSegments("sh -lc 'cd x && rm y'", [], true)).toEqual([
      ["sh", "-lc", "cd x && rm y"],
      ["cd", "x"],
      ["rm", "y"],
    ]);
    expect(shellRuleSegments("zsh", ["-e", "-o", "pipefail", "-c", "npm publish"], false)).toContainEqual([
      "npm",
      "publish",
    ]);
    expect(shellRuleSegments("sudo bash -ec 'npm publish'", [], true)).toContainEqual([
      "npm",
      "publish",
    ]);
  });

  it("unwraps shells nested in shells", () => {
    expect(
      shellRuleSegments(`bash -c "sh -c 'rm y'"`, [], true),
    ).toContainEqual(["rm", "y"]);
  });

  it("does not read a script's own `-c` argument as a command line", () => {
    expect(shellRuleSegments("bash", ["run.sh", "-c", "rm y"], false)).toEqual([
      ["bash", "run.sh", "-c", "rm y"],
    ]);
  });

  it("lists a wrapped command both ways", () => {
    expect(shellRuleSegments("FOO=1 sudo -n npm publish", [], true)).toEqual([
      ["FOO=1", "sudo", "-n", "npm", "publish"],
      ["npm", "publish"],
    ]);
  });
});
