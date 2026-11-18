import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../composio/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../composio/index.js")>();
  return {
    ...actual,
    resolveComposioServerConfig: vi.fn(actual.resolveComposioServerConfig),
    listComposioConnectedAccounts: vi.fn(actual.listComposioConnectedAccounts),
  };
});

import * as composioIndex from "../../composio/index.js";
import { persistComposioSession } from "../../composio/index.js";
import { getConfig, resetConfigCache } from "../../config/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { IntegrationsOrchestrator } from "./integrations-orchestrator.js";
import type { ComposioAccount } from "../../config/composio-accounts-config.js";
import { composioIntegration } from "../../integrations/composio-integration.js";
import type { IntegrationField } from "../../integrations/index.js";
import {
  COMPOSIO_ACCOUNT_FIELDS,
  applyComposioAccountField,
  checkComposioAccountToAdd,
  composioAccountsSummary,
  isComposioAccountField,
} from "./integrations-orchestrator-composio.js";

const resolveMock = vi.mocked(composioIndex.resolveComposioServerConfig);
const listMock = vi.mocked(composioIndex.listComposioConnectedAccounts);

const CONNECTED_WORK = { id: "ca_work", toolkit: "gmail", status: "ACTIVE", alias: null, displayName: null, createdAt: null };

let dir: string;
let configPath: string;

function field(key: string): IntegrationField {
  const f = composioIntegration.fields.find((x) => x.key === key);
  if (!f) throw new Error(`no field ${key}`);
  return f;
}

function saved(): ComposioAccount[] {
  return (JSON.parse(readFileSync(configPath, "utf8")) as { composio: { accounts: ComposioAccount[] } }).composio.accounts;
}

const WORK: ComposioAccount = { toolkit: "gmail", alias: "work", connectedAccountId: "ca_work", isDefault: true };
const HOME: ComposioAccount = { toolkit: "gmail", alias: "home", connectedAccountId: "ca_home", isDefault: false };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-composio-"));
  configPath = join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Composio account fields (ATO-1494)", () => {
  it("are the three transient fields and nothing else", () => {
    expect(isComposioAccountField(field(COMPOSIO_ACCOUNT_FIELDS.add))).toBe(true);
    expect(isComposioAccountField(field("apiKey"))).toBe(false);
  });

  it("add saves a named account, --default makes it the app's default", () => {
    const line = applyComposioAccountField(field("addAccount"), "Gmail work ca_work --default", [], configPath);
    expect(line).toContain('"work" saved');
    expect(saved()).toEqual([WORK]);
  });

  it("default moves to another name, and `none` clears it", () => {
    applyComposioAccountField(field("defaultAccount"), "gmail home", [WORK, HOME], configPath);
    expect(saved().map((a) => [a.alias, a.isDefault])).toEqual([["work", false], ["home", true]]);
    const line = applyComposioAccountField(field("defaultAccount"), "gmail none", [WORK, HOME], configPath);
    expect(line).toMatch(/no default/);
    expect(saved().every((a) => !a.isDefault)).toBe(true);
  });

  it("remove forgets one name", () => {
    applyComposioAccountField(field("removeAccount"), "gmail work", [WORK, HOME], configPath);
    expect(saved()).toEqual([HOME]);
  });

  it("refuses bad input with a message and writes nothing", () => {
    expect(() => applyComposioAccountField(field("addAccount"), "gmail work", [], configPath)).toThrow(/Type:/);
    expect(() => applyComposioAccountField(field("addAccount"), "gmail Work ca_1", [], configPath)).toThrow(/alias must be/);
    expect(() => applyComposioAccountField(field("removeAccount"), "gmail nope", [WORK], configPath)).toThrow(/no gmail account/);
    expect(() => applyComposioAccountField(field("defaultAccount"), "gmail", [WORK], configPath)).toThrow(/Type:/);
    expect(() => readFileSync(configPath)).toThrow();
  });
});

describe("checking an add against Composio", () => {
  const composio = { accounts: [] as ComposioAccount[], apiKeyEnv: "COMPOSIO_API_KEY", userId: "u-1" as string | null };
  const env = { COMPOSIO_API_KEY: "ak_dummy" };

  it("passes an id Composio has signed in for that app", async () => {
    const note = await checkComposioAccountToAdd("gmail work ca_work --default", {
      composio, env, listConnected: async () => [CONNECTED_WORK],
    });
    expect(note).toBeNull();
  });

  it("refuses an id Composio does not have, or one of another app", async () => {
    await expect(checkComposioAccountToAdd("gmail work ca_typo", {
      composio, env, listConnected: async () => [CONNECTED_WORK],
    })).rejects.toThrow(/no signed-in account ca_typo/);
    await expect(checkComposioAccountToAdd("slack work ca_work", {
      composio, env, listConnected: async () => [CONNECTED_WORK],
    })).rejects.toThrow(/is a gmail account on Composio, not slack/);
  });

  it("lets the add through with a note when Composio cannot be asked", async () => {
    const offline = await checkComposioAccountToAdd("gmail work ca_work", {
      composio, env, listConnected: async () => { throw new Error("offline"); },
    });
    expect(offline).toBe("offline");
    expect(await checkComposioAccountToAdd("gmail work ca_work", { composio, env: {} })).toBe("no API key");
    expect(await checkComposioAccountToAdd("gmail work ca_work", { composio: { ...composio, userId: null }, env })).toBe("no app connected yet");
  });
});

describe("the accounts action", () => {
  const composio = { accounts: [WORK, HOME], apiKeyEnv: "COMPOSIO_API_KEY", userId: "u-1" };

  it("lists saved names with the default starred, then signed-in ids not saved", async () => {
    const line = await composioAccountsSummary({
      composio,
      env: { COMPOSIO_API_KEY: "ak_dummy" },
      listConnected: async () => [
        { id: "ca_work", toolkit: "gmail", status: "ACTIVE", alias: null, displayName: null, createdAt: null },
        { id: "ca_new", toolkit: "slack", status: "ACTIVE", alias: null, displayName: "me@team.test", createdAt: null },
      ],
    });
    expect(line).toBe("Saved (* = default): gmail: home, *work · Not saved: slack ca_new (me@team.test)");
  });

  it("still shows the saved list when Composio cannot be asked", async () => {
    const line = await composioAccountsSummary({
      composio,
      env: { COMPOSIO_API_KEY: "ak_dummy" },
      listConnected: async () => {
        throw new Error("Could not reach Composio: offline");
      },
    });
    expect(line).toContain("gmail: home, *work");
    expect(line).toContain("Composio not asked: Could not reach Composio: offline");
    const noKey = await composioAccountsSummary({ composio: { ...composio, accounts: [] }, env: {} });
    expect(noKey).toBe("No saved accounts: every app uses the account connected last · Composio not asked: no API key");
  });
});

describe("IntegrationsOrchestrator — Composio accounts", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "hub-composio-orch-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    delete process.env.COMPOSIO_API_KEY;
    resetConfigCache();
  });

  afterEach(() => {
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.COMPOSIO_API_KEY;
    resetConfigCache();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("an account edit writes the list and remounts Composio without dropping the session", async () => {
    persistComposioSession(getConfig().paths.userConfigFile, {
      userId: "u-1",
      sessionId: "trs_kept",
      mcpUrl: "https://example.test/mcp",
    });
    const removeServerLive = vi.fn(async () => undefined);
    const actions: Array<{ type: string; message?: string; error?: string }> = [];
    const runtime = {
      telegramChannel: null,
      discordChannel: null,
      mcpManager: { listStatuses: () => [], removeServerLive, addServerLive: vi.fn() },
      refreshMcp: vi.fn(async () => undefined),
    } as unknown as AgentRuntime;
    const bus = { emit: (a: unknown) => actions.push(a as never), subscribe: () => () => {} };
    const hub = new IntegrationsOrchestrator(runtime, bus as never);
    await hub.saveField("composio", "addAccount", "gmail work ca_work --default");
    expect(getConfig().composio.accounts).toEqual([WORK]);
    expect(getConfig().composio.sessionId).toBe("trs_kept");
    expect(removeServerLive).toHaveBeenCalledWith("composio");
    const settled = actions.filter((a) => a.type === "integrations_action_settled").at(-1);
    expect(settled?.message).toContain('"work" saved');
  });

  function hubWithKey() {
    process.env.COMPOSIO_API_KEY = "ak_dummy";
    resetConfigCache();
    persistComposioSession(getConfig().paths.userConfigFile, {
      userId: "u-1",
      sessionId: "trs_kept",
      mcpUrl: "https://example.test/mcp",
    });
    resetConfigCache();
    const removeServerLive = vi.fn(async () => undefined);
    const addServerLive = vi.fn(async () => undefined);
    const actions: Array<{ type: string; message?: string; error?: string }> = [];
    const runtime = {
      telegramChannel: null,
      discordChannel: null,
      mcpManager: { listStatuses: () => [], removeServerLive, addServerLive },
      refreshMcp: vi.fn(async () => undefined),
    } as unknown as AgentRuntime;
    const bus = { emit: (a: unknown) => actions.push(a as never), subscribe: () => () => {} };
    const hub = new IntegrationsOrchestrator(runtime, bus as never);
    const settled = () => actions.filter((a) => a.type === "integrations_action_settled").at(-1);
    return { hub, removeServerLive, addServerLive, settled };
  }

  it("refuses an account id Composio does not have and leaves Composio mounted", async () => {
    listMock.mockResolvedValueOnce([CONNECTED_WORK]);
    const { hub, removeServerLive, settled } = hubWithKey();
    await hub.saveField("composio", "addAccount", "gmail work ca_typo --default");
    expect(settled()?.error).toMatch(/no signed-in account ca_typo/);
    expect(settled()?.message).toBeUndefined();
    expect(getConfig().composio.accounts).toEqual([]);
    expect(removeServerLive).not.toHaveBeenCalled();
  });

  it("says Composio is off and how to get it back when the remount fails", async () => {
    listMock.mockResolvedValueOnce([CONNECTED_WORK]);
    resolveMock.mockResolvedValueOnce(undefined);
    const { hub, addServerLive, settled } = hubWithKey();
    await hub.saveField("composio", "addAccount", "gmail work ca_work --default");
    expect(getConfig().composio.accounts).toEqual([WORK]);
    expect(addServerLive).not.toHaveBeenCalled();
    expect(settled()?.message).toBeUndefined();
    expect(settled()?.error).toContain("Composio did not start with it");
    expect(settled()?.error).toContain('"gmail none" in Default account');
    expect(settled()?.error).toContain('"gmail work" in Remove account');
  });

  it("saves with a note when Composio cannot be asked, and remounts", async () => {
    listMock.mockRejectedValueOnce(new Error("Could not reach Composio: offline"));
    resolveMock.mockResolvedValueOnce({ name: "composio" } as never);
    const { hub, addServerLive, settled } = hubWithKey();
    await hub.saveField("composio", "addAccount", "gmail work ca_work --default");
    expect(getConfig().composio.accounts).toEqual([WORK]);
    expect(addServerLive).toHaveBeenCalled();
    expect(settled()?.error).toBeUndefined();
    expect(settled()?.message).toContain('"work" saved');
    expect(settled()?.message).toContain("not checked with Composio: Could not reach Composio: offline");
  });
});
