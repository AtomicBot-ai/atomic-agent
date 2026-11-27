import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CommandOptions, CommandResult } from "../../../sandbox/command-runner.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsFsGrepTool } from "./fs-grep.js";

/**
 * ATO-2703: a guest's recursive grep of the working directory must not
 * return a nested `.env`, key or `secrets/` file. The runner is faked:
 * it answers as ripgrep would WITHOUT the exclusions, so the tool's own
 * filter is what keeps the secret out, and the args show the exclusions.
 */
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fs-grep-guest-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctx = (guest: boolean): ToolContext => ({
  workingDir: root,
  sessionId: "s",
  stepIndex: 0,
  signal: new AbortController().signal,
  ...(guest ? { guest: true } : {}),
});

const match = (path: string, text: string) => ({
  type: "match",
  data: { path: { text: path }, lines: { text: `${text}\n` }, line_number: 1, absolute_offset: 0, submatches: [] },
});
const STDOUT = [
  match("./config/.env", "API_KEY=sk-live-guest-must-not-see"),
  match("./deploy/secrets/token.txt", "API_KEY=token-guest-must-not-see"),
  match("./src/app.ts", "const API_KEY = process.env.API_KEY;"),
].map((line) => JSON.stringify(line)).join("\n") + "\n";

function fakeRunner() {
  const calls: string[][] = [];
  const runCommand = async (command: string, args: string[], _options: CommandOptions): Promise<CommandResult> => {
    calls.push(args);
    return { command, args, exitCode: 0, signal: null, stdout: STDOUT, stderr: "", durationMs: 1, timedOut: false, truncated: false, inputTruncated: false };
  };
  return { calls, runCommand };
}

describe("os.fs.grep for a guest (ATO-2703)", () => {
  it("drops nested secret files from a guest's results and keeps ordinary ones", async () => {
    const { runCommand } = fakeRunner();
    const tool = buildOsFsGrepTool({ resolveRgPath: () => "rg", runCommand });
    const result = await tool.run({ pattern: "API_KEY", outputMode: "content" }, ctx(true));
    const text = JSON.stringify(result);
    expect(text).not.toContain("guest-must-not-see");
    expect(text).not.toContain("config/.env");
    expect(text).not.toContain("token.txt");
    expect(text).toContain("src/app.ts");
  });

  it("still shows the owner every match", async () => {
    const { runCommand } = fakeRunner();
    const tool = buildOsFsGrepTool({ resolveRgPath: () => "rg", runCommand });
    const text = JSON.stringify(await tool.run({ pattern: "API_KEY", outputMode: "content" }, ctx(false)));
    expect(text).toContain("sk-live-guest-must-not-see");
    expect(text).toContain("src/app.ts");
  });

  it("passes ripgrep the secret exclusions after a guest's own globs, and none for the owner", async () => {
    const guest = fakeRunner();
    await buildOsFsGrepTool({ resolveRgPath: () => "rg", runCommand: guest.runCommand }).run({ pattern: "x", glob: ".env" }, ctx(true));
    const args = guest.calls[0]!;
    const own = args.indexOf(".env");
    const exclusion = args.indexOf("!.env");
    expect(own).toBeGreaterThan(-1);
    expect(args[exclusion - 1]).toBe("--iglob");
    // Later globs win in ripgrep: the exclusion must come after the guest's glob.
    expect(exclusion).toBeGreaterThan(own);
    expect(exclusion).toBeLessThan(args.indexOf("--"));

    const owner = fakeRunner();
    await buildOsFsGrepTool({ resolveRgPath: () => "rg", runCommand: owner.runCommand }).run({ pattern: "x" }, ctx(false));
    expect(owner.calls[0]).not.toContain("--iglob");
  });
});
