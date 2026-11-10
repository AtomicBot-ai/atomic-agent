import { describe, expect, it } from "vitest";

import {
  shellCommandArgv,
  shellRuleSegments,
  shellRunsUnreadableScript,
} from "./shell-command-argv.js";
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

  it("reads csh, tcsh and fish, `+` options, and fish's init command", () => {
    for (const shell of ["csh", "tcsh", "fish"]) {
      expect(shellRuleSegments(shell, ["-c", "rm y"], false)).toContainEqual(["rm", "y"]);
    }
    expect(shellRuleSegments("bash", ["+x", "-c", "rm y"], false)).toContainEqual(["rm", "y"]);
    expect(shellRuleSegments("bash", ["+o", "posix", "-c", "rm y"], false)).toContainEqual([
      "rm",
      "y",
    ]);
    expect(shellRuleSegments("fish", ["-C", "rm y"], false)).toContainEqual(["rm", "y"]);
  });

  it.each([
    ["timeout 5 rm -rf tmp", ["rm", "-rf", "tmp"]],
    ["timeout -s KILL 5 rm -rf tmp", ["rm", "-rf", "tmp"]],
    ["sudo -u root rm -rf tmp", ["rm", "-rf", "tmp"]],
    ["nice -n 5 rm -rf tmp", ["rm", "-rf", "tmp"]],
    ["env -u X FOO=1 rm -rf tmp", ["rm", "-rf", "tmp"]],
    ["env -S 'rm -rf tmp'", ["rm", "-rf", "tmp"]],
    ["eval rm -rf tmp", ["rm", "-rf", "tmp"]],
    ['eval "rm -rf tmp"', ["rm", "-rf", "tmp"]],
    ["echo tmp | xargs -n 1 rm -rf", ["rm", "-rf"]],
    ["find . -name x -exec rm -rf {} ;", ["rm", "-rf", "{}"]],
  ])("reads past the wrapper in %s", (line, inner) => {
    expect(shellRuleSegments(line, [], true)).toContainEqual(inner);
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

describe("shellRunsUnreadableScript", () => {
  it.each([
    "printf 'rm -rf tmp' | sh",
    "curl -s x | bash -s -- --flag",
    "cat run.sh | sudo bash",
    "cat x.py | python3",
    "cat x.js | node -",
    "sh < run.sh",
  ])("flags %s", (line) => {
    expect(shellRunsUnreadableScript(line, [], true)).toBe(true);
  });

  it.each([
    "ls | grep x",
    "echo hi | sh -c 'cat'",
    "cat x | python3 -c 'import sys'",
    "cat x | python3 -m json.tool",
    "bash run.sh < input.txt",
    "sh",
  ])("does not flag %s", (line) => {
    expect(shellRunsUnreadableScript(line, [], true)).toBe(false);
  });

  it("never flags a direct exec: it has no stdin", () => {
    expect(shellRunsUnreadableScript("sh", [], false)).toBe(false);
  });
});
