import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getStateSecretDirectories,
  getStateSecretPaths,
  getUserConfigPath,
} from "../../config/config-file.js";
import { checkGuestRead } from "./guest-reads.js";
import { READ_TOOL_TARGETS } from "./read-scope-targets.js";
import { findStateSecretReads, type StateSecrets } from "./state-secrets.js";

// ATO-2496 review round 3 (F1925-R3.1): `os.code.search` and
// `os.fs.code_map` trim `path` before use, but the checks read it as
// given. A padded `" <stateDir> "` resolved under the working directory,
// so the owner got no ask while the tool searched the state folder, and
// a guest's `" ../outside"` passed the guest check.
const posix = describe.skipIf(process.platform === "win32");

posix("padded paths are checked as the tools read them (ATO-2496)", () => {
  let home: string;
  let stateDir: string;
  let work: string;
  let secrets: StateSecrets;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "padded-paths-"));
    stateDir = join(home, ".atomic-agent");
    work = join(home, "project");
    mkdirSync(join(stateDir, "auth"), { recursive: true });
    mkdirSync(join(work, "src"), { recursive: true });
    mkdirSync(join(home, "outside"), { recursive: true });
    writeFileSync(join(stateDir, "auth", "chatgpt.json"), '{"accessToken":"at-secret"}\n');
    writeFileSync(join(home, "outside", "notes.json"), '{"a":1}\n');
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

  it("asks the owner for a code search or code map over a padded state folder", () => {
    const search = { path: ` ${stateDir} `, lang: "json", pattern: '"accessToken": $V' };
    expect(findStateSecretReads("os.code.search", search, { workingDir: work }, secrets)).not.toEqual([]);
    expect(findStateSecretReads("os.fs.code_map", { path: ` ${stateDir}` }, { workingDir: work }, secrets)).not.toEqual([]);
    // `" . "` from inside the state folder is the state folder.
    const dot = { path: " . ", lang: "json", pattern: "$A" };
    expect(findStateSecretReads("os.code.search", dot, { workingDir: stateDir }, secrets)).not.toEqual([]);
  });

  it("refuses a guest's padded path that leads out of the working directory", () => {
    const result = checkGuestRead(
      "os.code.search",
      { path: " ../outside", lang: "json", pattern: "$A" },
      { guest: true, workingDir: work },
      { home, stateDir },
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe("error");
  });

  it("leaves a padded path inside the project alone", () => {
    const args = { path: " src ", lang: "ts", pattern: "$A" };
    expect(findStateSecretReads("os.code.search", args, { workingDir: work }, secrets)).toEqual([]);
    expect(checkGuestRead("os.code.search", args, { guest: true, workingDir: work }, { home, stateDir })).toBeNull();
  });

  it("names both spellings of a padded path", () => {
    expect(READ_TOOL_TARGETS.get("os.fs.read")!({ path: " a.txt " })).toEqual([" a.txt ", "a.txt"]);
    expect(READ_TOOL_TARGETS.get("os.fs.read")!({ path: "a.txt" })).toEqual(["a.txt"]);
    expect(READ_TOOL_TARGETS.get("os.fs.read")!({ path: "   " })).toEqual(["   "]);
  });
});
