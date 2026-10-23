import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./git-runner.js";

// ATO-347: git runs hooks, aliases and credential helpers, which must not
// read the agent's provider keys. An explicit `env` from the caller (the
// GitHub token injection) still reaches git.
describe.skipIf(process.platform === "win32")(
  "runGit does not hand the agent's secrets to git",
  () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "atomic-git-env-"));
      process.env.ATO347_GIT_API_KEY = "leaked-key-value";
      process.env.ATO347_GIT_PLAIN = "plain-value";
    });

    afterEach(async () => {
      delete process.env.ATO347_GIT_API_KEY;
      delete process.env.ATO347_GIT_PLAIN;
      await rm(dir, { recursive: true, force: true });
    });

    it("strips secret-looking variables and keeps an explicit env", async () => {
      const result = await runGit({
        workingDir: dir,
        signal: new AbortController().signal,
        // One printenv per name: BSD printenv on macOS takes a single name.
        args: [
          "-c",
          "alias.showenv=!printenv ATO347_GIT_PLAIN; printenv ATO347_GIT_API_KEY; printenv ATO347_GIT_OWN_TOKEN; true",
          "showenv",
        ],
        env: { ATO347_GIT_OWN_TOKEN: "explicit-value" },
      });
      expect(result.stdout).toContain("plain-value");
      expect(result.stdout).toContain("explicit-value");
      expect(result.stdout).not.toContain("leaked-key-value");
    });
  },
);
