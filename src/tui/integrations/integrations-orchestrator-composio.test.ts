import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  composioAccountsSummary,
  isComposioAccountField,
} from "./integrations-orchestrator-composio.js";

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
});
