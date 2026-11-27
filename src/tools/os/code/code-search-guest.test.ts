import { mkdtemp, rm, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CommandResult } from "../../../sandbox/command-runner.js";
import type { ToolContext } from "../../tool-registry.js";
import type { AstGrepDependencies } from "./ast-grep-run.js";
import { buildOsCodeSearchTool } from "./code-search.js";

/**
 * ATO-2703 (review F1963.1): ast-grep parses YAML and JSON, so a guest's
 * `os.code.search {pattern:"$K: $V", lang:"yaml", globs:["**\/secrets/**"]}`
 * printed the values of `secrets/prod.yaml`. A guest's matches in secret
 * files are dropped; the owner still gets every match.
 */
let work: string;
let aliasDir: string;
let alias: string;

beforeAll(async () => {
  work = realpathSync(await mkdtemp(join(tmpdir(), "code-search-guest-")));
  aliasDir = await mkdtemp(join(tmpdir(), "code-search-alias-"));
  alias = join(aliasDir, "link");
  await symlink(work, alias);
});
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
  await rm(aliasDir, { recursive: true, force: true });
});

const match = (file: string, line: string): Record<string, unknown> => ({
  text: line,
  range: { byteOffset: { start: 0, end: line.length }, start: { line: 0, column: 0 }, end: { line: 0, column: line.length } },
  file,
  lines: line,
  language: "Yaml",
});

function deps(files: (realRoot: string) => Array<[string, string]>): Partial<AstGrepDependencies> {
  return {
    resolveAstGrepPath: () => "/usr/local/bin/ast-grep",
    neutralConfig: async () => "/tmp/atomic-ast-grep-test/sgconfig.yml",
    runCommand: async (): Promise<CommandResult> => ({
      command: "ast-grep",
      args: [],
      exitCode: 0,
      signal: null,
      stdout: files(work).map(([f, l]) => JSON.stringify(match(f, l))).join("\n"),
      stderr: "",
      durationMs: 1,
      timedOut: false,
      truncated: false,
      inputTruncated: false,
    }),
  };
}

const ctx = (workingDir: string, guest: boolean): ToolContext => ({
  workingDir,
  sessionId: "s",
  stepIndex: 0,
  signal: new AbortController().signal,
  ...(guest ? { guest: true } : {}),
});

const HITS = (root: string): Array<[string, string]> => [
  [join(root, "secrets", "prod.yaml"), "db_password: hunter2-guest-must-not-see"],
  [join(root, "config", "credentials.json"), "\"token\": \"guest-must-not-see\""],
  [join(root, "app", ".env.yaml"), "API_KEY: guest-must-not-see"],
  [join(root, "config", "app.yaml"), "port: 8080"],
];

describe("os.code.search for a guest (ATO-2703)", () => {
  it("drops matches in secrets/, credentials and .env files and keeps the rest", async () => {
    const tool = buildOsCodeSearchTool(deps(HITS));
    const result = await tool.run({ pattern: "$K: $V", lang: "yaml", globs: ["**/secrets/**"] }, ctx(work, true));
    const text = JSON.stringify(result);
    expect(text).not.toContain("guest-must-not-see");
    expect(text).toContain("port: 8080");
    expect(result.details.totals).toEqual({ files: 1, matches: 1 });
  });

  it("drops them when the working directory is a symlink and ast-grep prints real paths", async () => {
    const tool = buildOsCodeSearchTool(deps(HITS));
    const result = await tool.run({ pattern: "$K: $V", lang: "yaml" }, ctx(alias, true));
    expect(JSON.stringify(result)).not.toContain("guest-must-not-see");
  });

  it("shows the owner every match", async () => {
    const tool = buildOsCodeSearchTool(deps(HITS));
    const result = await tool.run({ pattern: "$K: $V", lang: "yaml" }, ctx(work, false));
    expect(JSON.stringify(result)).toContain("hunter2-guest-must-not-see");
    expect(result.details.totals).toEqual({ files: 4, matches: 4 });
  });
});
