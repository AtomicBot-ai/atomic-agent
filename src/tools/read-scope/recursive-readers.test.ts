import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getStateSecretDirectories,
  getStateSecretPaths,
  getUserConfigPath,
} from "../../config/config-file.js";
import { READ_TOOL_TARGETS } from "./read-scope-targets.js";
import { findStateSecretReads, RECURSIVE_READ_TOOLS, type StateSecrets } from "./state-secrets.js";

// ATO-2496 review round 1 (F1925.1): `os.code.search` / `os.code.rewrite`
// pointed at the state folder walk the sign-in folders and the named-token
// file and print the matched text. Like `os.fs.grep`, a code search, a
// code map or a My files search rooted at a folder holding a secret asks.
const posix = describe.skipIf(process.platform === "win32");

posix("recursive readers rooted at the state folder (ATO-2496)", () => {
  let home: string;
  let stateDir: string;
  let work: string;
  let secrets: StateSecrets;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "recursive-readers-"));
    stateDir = join(home, ".atomic-agent");
    work = join(home, "project");
    mkdirSync(join(stateDir, "auth"), { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(stateDir, "auth", "chatgpt.json"), '{"accessToken":"at-secret"}\n');
    writeFileSync(join(stateDir, "http-tokens.json"), '{"tokens":[]}\n');
    writeFileSync(join(work, "index.ts"), "export const a = 1;\n");
    secrets = {
      stateDir,
      files: getStateSecretPaths({
        stateDir,
        userConfigFile: getUserConfigPath(stateDir),
        localModelsDataDir: join(stateDir, "models"),
      }),
      secretDirectories: getStateSecretDirectories(stateDir),
    };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const ctx = (): { workingDir: string } => ({ workingDir: work });

  it("asks for os.code.search over the state folder", () => {
    const args = { path: stateDir, lang: "json", pattern: '"accessToken": $V' };
    expect(findStateSecretReads("os.code.search", args, ctx(), secrets)).not.toEqual([]);
  });

  it("asks for an os.code.rewrite dry run over the state folder", () => {
    const args = { path: stateDir, lang: "json", pattern: "$K: $V", rewrite: "$K: $V" };
    expect(findStateSecretReads("os.code.rewrite", args, ctx(), secrets)).not.toEqual([]);
  });

  it("asks for a code map and a My files search rooted at the state folder", () => {
    expect(findStateSecretReads("os.fs.code_map", { path: stateDir }, ctx(), secrets)).not.toEqual([]);
    expect(findStateSecretReads("files.search", { query: "token", folder: stateDir }, ctx(), secrets)).not.toEqual([]);
  });

  it("leaves a code search of the project alone", () => {
    expect(findStateSecretReads("os.code.search", { path: work, lang: "ts", pattern: "$A" }, ctx(), secrets)).toEqual([]);
  });

  it("covers every recursive reader through READ_TOOL_TARGETS", () => {
    for (const tool of RECURSIVE_READ_TOOLS) expect(READ_TOOL_TARGETS.has(tool)).toBe(true);
  });
});
