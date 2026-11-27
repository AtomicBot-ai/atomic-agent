import { describe, expect, it } from "vitest";

import { claudeCliAdapter } from "./claude-cli-adapter.js";
import {
  cliOutdatedMark,
  cliUpdateCommands,
  withCliOutdated,
  type CliVersionVerdict,
} from "./cli-version-check.js";
import type { CliRunOutcome } from "./run-cli-completion.js";
import type { CliStreamRunner } from "./stream-cli-completion.js";
import { SubscriptionCliProvider } from "./subscription-cli-provider.js";

/**
 * ATO-2523: a successful turn on an outdated CLI carries `cliOutdated`,
 * which the agent loop turns into the chat's `cli_outdated` event. Before,
 * the verdict was only logged on success.
 */

const outdated: CliVersionVerdict = {
  version: "2.1.0",
  minimum: "2.1.22",
  outdated: true,
  message: "Claude Code 2.1.0 is older than 2.1.22, the oldest version Atomic Agent works with. Update it with `claude update`, then retry.",
};
const current: CliVersionVerdict = { version: "2.1.300", minimum: "2.1.22", outdated: false, message: null };
const SUCCESS = JSON.stringify({ subtype: "success", is_error: false, result: "hi", usage: {} });
const answer = (stdout: string): CliRunOutcome => ({ stdout, stderr: "", exitCode: 0, durationMs: 1 });

describe("the update commands per platform", () => {
  it("offers `claude update` everywhere and no Homebrew on Windows", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(cliUpdateCommands("claude", platform)).toEqual(["claude update"]);
    }
    expect(cliUpdateCommands("codex", "darwin")).toEqual(["npm install -g @openai/codex@latest", "brew upgrade codex"]);
    expect(cliUpdateCommands("codex", "win32")).toEqual(["npm install -g @openai/codex@latest"]);
  });
});

describe("cliOutdatedMark", () => {
  it("marks only a version read and found too old", () => {
    expect(cliOutdatedMark(outdated, "claude", "Claude Code", "darwin")).toEqual({
      cli: "claude",
      productName: "Claude Code",
      version: "2.1.0",
      minimum: "2.1.22",
      updateCommands: ["claude update"],
    });
    expect(cliOutdatedMark(current, "claude", "Claude Code", "darwin")).toBeNull();
    expect(cliOutdatedMark({ version: null, minimum: "2.1.22", outdated: false, message: null }, "claude", "Claude Code")).toBeNull();
    expect(cliOutdatedMark(null, "codex", "Codex")).toBeNull();
  });

  it("leaves a completion alone without a mark", () => {
    const result = { content: "x" } as never;
    expect(withCliOutdated(result, null)).toBe(result);
  });
});

describe("SubscriptionCliProvider marks a successful turn on an outdated CLI", () => {
  it("on a buffered run", async () => {
    const claude = new SubscriptionCliProvider({
      id: "claude-cli",
      descriptor: claudeCliAdapter,
      cwd: "/tmp",
      runCliImpl: async () => answer(SUCCESS),
      versionCheck: async () => outdated,
    });
    const done = await claude.complete({ prompt: "p" } as never);
    expect(done.content).toBe("hi");
    expect(done.cliOutdated).toMatchObject({ cli: "claude", version: "2.1.0", minimum: "2.1.22", updateCommands: ["claude update"] });
  });

  it("on a streamed run", async () => {
    const streamCliImpl: CliStreamRunner = async function* () {
      yield JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "hi", usage: {} });
    };
    const provider = new SubscriptionCliProvider({
      id: "claude-cli",
      descriptor: claudeCliAdapter,
      cwd: "/tmp",
      streamCliImpl,
      versionCheck: async () => outdated,
    });
    const iterator = provider.completeStream({ prompt: "p" } as never);
    let next = await iterator.next();
    while (!next.done) next = await iterator.next();
    expect(next.value.cliOutdated).toMatchObject({ cli: "claude", version: "2.1.0" });
  });

  it("not on a current CLI", async () => {
    const provider = new SubscriptionCliProvider({
      id: "claude-cli",
      descriptor: claudeCliAdapter,
      cwd: "/tmp",
      runCliImpl: async () => answer(SUCCESS),
      versionCheck: async () => current,
    });
    const done = await provider.complete({ prompt: "p" } as never);
    expect(done.cliOutdated).toBeUndefined();
  });
});
