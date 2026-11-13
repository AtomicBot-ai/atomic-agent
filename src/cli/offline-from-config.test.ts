import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";

import { applyOfflineModeFromConfigFile } from "./offline-from-config.js";
import {
  OfflineNetworkError,
  egressSnapshot,
  isOfflineNetwork,
  resetOfflineNetworkForTests,
} from "../llm/offline-network.js";
import {
  installTransportDeadlines,
  resetTransportDeadlines,
} from "../llm/transport-deadlines.js";
import { checkForAppUpdate } from "../update/index.js";

describe("applyOfflineModeFromConfigFile (ATO-1084)", () => {
  const original = getGlobalDispatcher();
  let stateDir: string;
  const savedEnv = process.env.ATOMIC_AGENT_OFFLINE;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-cli-offline-"));
    delete process.env.ATOMIC_AGENT_OFFLINE;
    resetOfflineNetworkForTests();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.ATOMIC_AGENT_OFFLINE;
    else process.env.ATOMIC_AGENT_OFFLINE = savedEnv;
    resetOfflineNetworkForTests();
    setGlobalDispatcher(original);
    resetTransportDeadlines();
  });

  function writeConfig(text: string): void {
    writeFileSync(join(stateDir, "config.json"), text);
  }

  it("blocks the update check of a command that builds no runtime", async () => {
    writeConfig(JSON.stringify({ version: 1, network: { offline: true } }));
    installTransportDeadlines();
    expect(applyOfflineModeFromConfigFile(stateDir)).toBe(true);
    expect(isOfflineNetwork()).toBe(true);

    const failure = await checkForAppUpdate({ force: true }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(Error);
    const cause = (failure as Error & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(OfflineNetworkError);
    expect(egressSnapshot().requestsBlocked).toBe(1);
    expect(egressSnapshot().requestsOut).toBe(0);
  });

  it("leaves offline mode off when the file does not ask for it", () => {
    writeConfig(JSON.stringify({ version: 1, network: { offline: false } }));
    expect(applyOfflineModeFromConfigFile(stateDir)).toBe(false);
    expect(isOfflineNetwork()).toBe(false);
  });

  it("treats a missing or malformed config as off and writes nothing", () => {
    expect(applyOfflineModeFromConfigFile(stateDir)).toBe(false);
    expect(readdirSync(stateDir)).toEqual([]);
    writeConfig("{ not json");
    expect(applyOfflineModeFromConfigFile(stateDir)).toBe(false);
    expect(isOfflineNetwork()).toBe(false);
  });
});
