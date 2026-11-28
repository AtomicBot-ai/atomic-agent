import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shellWriteAnalysis } from "./write-targets.js";

/**
 * Review round 3 of ATO-2505: the extract and config analysis on every
 * platform, Windows included (`write-analysis.test.ts` skips win32 for
 * its POSIX paths). Only home-based lines, which read the same in cmd.
 */
describe("shellWriteAnalysis on every platform (ATO-2505 round 3)", () => {
  const cwd = process.cwd();
  const home = homedir();

  it.each(["tar xzf p.tgz -C ~", "tar xfC x.tar ~", "tar xCf ~ x.tar", "unzip x.zip -d ~", "cd ~ && tar xf x.tar"])(
    "names home as where an extract lands: %s",
    (line) => {
      expect(shellWriteAnalysis(line, cwd)?.trees).toEqual([home]);
    },
  );

  it.each([
    ["git config --global core.hooksPath h", join(home, ".gitconfig")],
    ["npm config set registry http://evil.example", join(home, ".npmrc")],
    ["npm set registry http://evil.example", join(home, ".npmrc")],
  ])("names the user config file a command writes: %s", (line, file) => {
    expect(shellWriteAnalysis(line, cwd)?.targets).toEqual([file]);
  });

  it.each(["npm config get registry", "git config --global --get user.name", "tar tf x.tar"])(
    "names nothing for a read: %s",
    (line) => {
      const analysis = shellWriteAnalysis(line, cwd);
      expect(analysis?.targets).toEqual([]);
      expect(analysis?.trees).toEqual([]);
    },
  );
});
