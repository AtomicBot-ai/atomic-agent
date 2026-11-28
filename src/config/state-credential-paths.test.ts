import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { serveApiKeyPath } from "../cli/serve-api-key.js";
import { httpDevicesPath } from "../http/device-store.js";
import { httpTokensPath } from "../http/http-token-store.js";
import { modelShareKeyPath } from "../http/model-share-key.js";
import { subscriptionAuthDir, subscriptionTokenPath } from "../llm/provider/subscription-oauth/credential-store.js";
import { MCP_OAUTH_DIR, mcpOAuthFilePath } from "../mcp/mcp-oauth-store.js";
import { categorizeFsMutation } from "../tools/os/fs/fs-approval-scope.js";
import {
  getStateSecretDirectories,
  getStateSecretPaths,
  getTrustConfigPaths,
  getUserConfigPath,
  isTrustDirectoryEntry,
} from "./config-file.js";

// ATO-2496: `http-tokens.json` holds the SHA-256 of every named serve
// token with its role, and serve rereads it on change. It was in neither
// list, so os.fs.write could add an admin token hash unasked and os.fs.read
// could list them. Same for the other files and folders that let a caller in.
describe("state credential files (ATO-2496)", () => {
  let stateDir: string;
  let paths: { stateDir: string; userConfigFile: string; localModelsDataDir: string };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-cred-"));
    paths = {
      stateDir,
      userConfigFile: getUserConfigPath(stateDir),
      localModelsDataDir: join(stateDir, "models"),
    };
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("puts the named token file in the trust surface and the secret list", () => {
    expect(getTrustConfigPaths(paths)).toContain(httpTokensPath(stateDir));
    expect(getStateSecretPaths(paths)).toContain(httpTokensPath(stateDir));
  });

  it("pins every caller key against the path its owner writes", () => {
    const trust = getTrustConfigPaths(paths);
    for (const file of [
      httpTokensPath(stateDir),
      httpDevicesPath(stateDir),
      serveApiKeyPath(stateDir),
      modelShareKeyPath(stateDir),
    ]) {
      expect(trust).toContain(file);
      expect(isTrustDirectoryEntry(file)).toBe(false);
    }
    // Once each: the secret list spreads the trust list.
    const secrets = getStateSecretPaths(paths);
    expect(new Set(secrets).size).toBe(secrets.length);
  });

  it("pins the sign-in folders against their owners, as directory entries", () => {
    const dirs = getStateSecretDirectories(stateDir);
    expect(dirs).toEqual([
      subscriptionAuthDir(stateDir) + sep,
      join(stateDir, MCP_OAUTH_DIR) + sep,
      // `whatsapp-channel.ts` spells it inline: `join(ctx.stateDir, "whatsapp-auth")`.
      join(stateDir, "whatsapp-auth") + sep,
    ]);
    for (const dir of dirs) {
      expect(isTrustDirectoryEntry(dir)).toBe(true);
      expect(getTrustConfigPaths(paths)).toContain(dir);
      expect(getStateSecretPaths(paths)).toContain(dir);
    }
    expect(subscriptionTokenPath(stateDir, "chatgpt").startsWith(dirs[0]!)).toBe(true);
    expect(mcpOAuthFilePath(stateDir, "github").startsWith(dirs[1]!)).toBe(true);
  });

  it("asks trust_config for a write to http-tokens.json, not a plain home write", async () => {
    writeFileSync(httpTokensPath(stateDir), '{"tokens":[]}\n');
    const category = await categorizeFsMutation("write", [httpTokensPath(stateDir)], {
      workingDir: stateDir,
      homeDir: stateDir,
      trustConfigPaths: getTrustConfigPaths(paths),
    });
    expect(category).toBe("trust_config");
  });

  it("asks trust_config for a write under a sign-in folder, existing or not", async () => {
    mkdirSync(subscriptionAuthDir(stateDir), { recursive: true });
    const trustConfigPaths = getTrustConfigPaths(paths);
    for (const target of [
      subscriptionTokenPath(stateDir, "chatgpt"),
      mcpOAuthFilePath(stateDir, "github"),
      join(stateDir, "whatsapp-auth", "creds.json"),
    ]) {
      const category = await categorizeFsMutation("write", [target], {
        workingDir: stateDir,
        homeDir: stateDir,
        trustConfigPaths,
      });
      expect(category).toBe("trust_config");
    }
  });
});
