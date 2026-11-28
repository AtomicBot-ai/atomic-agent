import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getStateSecretDirectories,
  getStateSecretPaths,
  getUserConfigPath,
} from "../../config/config-file.js";
import { findShellStateSecrets, findStateSecretReads, type StateSecrets } from "./state-secrets.js";

// ATO-2496: a read tool on the named-token file or on a sign-in folder
// (subscription tokens, MCP OAuth, WhatsApp keys) asks as state_secret.
// Directory entries of `files` alone only guard the shell (plugin files
// are meant to be read), so the sign-in folders need `secretDirectories`.
const posix = describe.skipIf(process.platform === "win32");

posix("sign-in folders and the named-token file (ATO-2496)", () => {
  let home: string;
  let stateDir: string;
  let work: string;
  let secrets: StateSecrets;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "secret-dirs-"));
    stateDir = join(home, ".atomic-agent");
    work = join(home, "project");
    mkdirSync(join(stateDir, "auth"), { recursive: true });
    mkdirSync(join(stateDir, "mcp-oauth"), { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(stateDir, "auth", "chatgpt.json"), '{"accessToken":"at-secret"}\n');
    writeFileSync(join(stateDir, "mcp-oauth", "github.json"), '{"access_token":"gho-secret"}\n');
    writeFileSync(join(stateDir, "http-tokens.json"), '{"tokens":[]}\n');
    const paths = {
      stateDir,
      userConfigFile: getUserConfigPath(stateDir),
      localModelsDataDir: join(stateDir, "models"),
    };
    secrets = {
      stateDir,
      files: getStateSecretPaths(paths),
      secretDirectories: getStateSecretDirectories(stateDir),
    };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const ctx = (): { workingDir: string } => ({ workingDir: work });

  it("asks for os.fs.read of http-tokens.json", () => {
    const hits = findStateSecretReads("os.fs.read", { path: join(stateDir, "http-tokens.json") }, ctx(), secrets);
    expect(hits).toEqual([join(stateDir, "http-tokens.json")]);
  });

  it("asks for os.fs.read of a file in a sign-in folder", () => {
    for (const file of [join(stateDir, "auth", "chatgpt.json"), join(stateDir, "mcp-oauth", "github.json")]) {
      expect(findStateSecretReads("os.fs.read", { path: file }, ctx(), secrets)).toHaveLength(1);
    }
  });

  it("asks for a listing of the folder and a not-yet-written file in it", () => {
    expect(findStateSecretReads("os.fs.list", { path: join(stateDir, "mcp-oauth") }, ctx(), secrets)).toHaveLength(1);
    expect(
      findStateSecretReads("os.fs.read", { path: join(stateDir, "whatsapp-auth", "creds.json") }, ctx(), secrets),
    ).toHaveLength(1);
  });

  it("follows a symlink from the workspace into a sign-in folder", () => {
    const link = join(work, "looks-harmless.json");
    symlinkSync(join(stateDir, "auth", "chatgpt.json"), link);
    expect(findStateSecretReads("os.fs.read", { path: link }, ctx(), secrets)).toHaveLength(1);
  });

  it("leaves a plugin file readable: only the sign-in folders guard reads", () => {
    mkdirSync(join(stateDir, "plugins", "installed", "p"), { recursive: true });
    const readme = join(stateDir, "plugins", "installed", "p", "README.md");
    writeFileSync(readme, "hi\n");
    expect(findStateSecretReads("os.fs.read", { path: readme }, ctx(), secrets)).toEqual([]);
  });

  it("asks for a shell command naming a sign-in file", () => {
    const hits = findShellStateSecrets(
      { cmd: `cat ${join(stateDir, "auth", "chatgpt.json")}` },
      ctx(),
      secrets,
      { home, platform: "darwin" },
    );
    expect(hits.length).toBeGreaterThan(0);
  });
});
