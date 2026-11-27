import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConfig, resetConfigCache } from "../config/index.js";
import { readModelShareSettings, writeModelShareMode, writeModelSharePort } from "../http/model-share-settings.js";
import { configCommand } from "./config-command.js";
import { runModelsShare, setModelShareEnabled } from "./models-share-command.js";

/**
 * ATO-2483: `atomic-agent models share` against a real state dir.
 *
 * - The printed addresses follow the saved share port and mode, as
 *   `GET /api/model-share` does: no LAN address in local mode.
 * - An off by any path (`config set`, `setModelShareEnabled`) forgets the
 *   network, so turning sharing on again is this computer only.
 */
describe("models share, run", () => {
  let stateDir: string;
  let stdout = "";

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "models-share-run-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
    stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  const configPath = (): string => getConfig().paths.userConfigFile;
  const lastJson = (): { mode: string; urls: { local: string; lan: string[] } } => {
    const lines = stdout.trim().split("\n");
    return JSON.parse(lines[lines.length - 1]!);
  };

  it("prints the saved share port, not 8787", async () => {
    writeModelSharePort(configPath(), 9100);
    expect(await runModelsShare(["--network", "--json"])).toBe(0);
    const out = lastJson();
    expect(out.urls.local).toBe("http://127.0.0.1:9100/raw/v1");
    expect(out.urls.lan.every((url) => url.endsWith(":9100/raw/v1"))).toBe(true);
  });

  it("--port saves the share port and prints it", async () => {
    expect(await runModelsShare(["--port", "9200", "--json"])).toBe(0);
    expect(readModelShareSettings(configPath()).port).toBe(9200);
    expect(lastJson().urls.local).toBe("http://127.0.0.1:9200/raw/v1");
  });

  it("lists no address for other devices in local mode", async () => {
    expect(await runModelsShare(["--local", "--json"])).toBe(0);
    expect(lastJson()).toMatchObject({ mode: "local", urls: { lan: [] } });
    stdout = "";
    expect(await runModelsShare(["--local"])).toBe(0);
    expect(stdout).not.toContain("Base URL, other devices");
  });

  it("config set ...share false forgets the network: turning it on again is local", async () => {
    writeModelShareMode(configPath(), "network");
    expect(await configCommand(["set", "localModels.managed.share", "false"])).toBe(0);
    expect(readFileSync(configPath(), "utf8")).not.toContain("shareNetwork");
    expect(await configCommand(["set", "localModels.managed.share", "true"])).toBe(0);
    expect(readModelShareSettings(configPath()).mode).toBe("local");
  });

  it("plain models share after an off that left shareNetwork in the file is local", async () => {
    // An older build or a hand edit can leave the key behind an off.
    writeModelShareMode(configPath(), "off");
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as { localModels: { managed: Record<string, unknown> } };
    raw.localModels.managed.shareNetwork = true;
    writeFileSync(configPath(), JSON.stringify(raw));
    resetConfigCache();
    expect(await runModelsShare(["--json"])).toBe(0);
    expect(lastJson().mode).toBe("local");
    expect(readModelShareSettings(configPath()).mode).toBe("local");
  });

  it("setModelShareEnabled off drops the network choice from the file", () => {
    writeModelShareMode(configPath(), "network");
    setModelShareEnabled(configPath(), false);
    expect(readFileSync(configPath(), "utf8")).not.toContain("shareNetwork");
    setModelShareEnabled(configPath(), true);
    expect(readModelShareSettings(configPath()).mode).toBe("local");
  });
});
