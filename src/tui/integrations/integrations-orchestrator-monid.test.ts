import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConfig, resetConfigCache } from "../../config/index.js";
import { parseAddServerJson, persistMcpServer } from "../../config/mcp-server-commands.js";
import { buildMcpCatalogJson, findMcpCatalogEntry } from "../../mcp/mcp-catalog.js";
import { createMcpOAuthStore } from "../../mcp/mcp-oauth-store.js";
import type { McpOAuthStartResult } from "../../mcp/mcp-oauth-flow.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";

import { IntegrationsOrchestrator } from "./integrations-orchestrator.js";
import { readMcpSignedIn } from "./integrations-orchestrator-monid.js";
import type { IntegrationRow } from "./integrations-panel-state.js";

const MONID_URL = "https://mcp.monid.ai/v1";
const AUTH_URL = "https://auth.monid.ai/authorize?state=abc";

function makeBus() {
  const actions: Array<{ type: string } & Record<string, unknown>> = [];
  return {
    emit(action: unknown) {
      actions.push(action as { type: string } & Record<string, unknown>);
    },
    subscribe() {
      return () => {};
    },
    actions,
  };
}

function makeHub(
  opts: {
    states?: Array<{ name: string; state: string }>;
    start?: (name: string) => Promise<McpOAuthStartResult>;
    withoutSignIn?: boolean;
  } = {},
) {
  const bus = makeBus();
  const addServerLive = vi.fn(async () => ({ added: true, tools: [] }));
  const refreshMcp = vi.fn(async () => undefined);
  const runtime = {
    telegramChannel: null,
    discordChannel: null,
    mcpManager: { listStatuses: () => opts.states ?? [], addServerLive },
    refreshMcp,
  } as unknown as AgentRuntime;
  const startSignIn = vi.fn(
    opts.start ?? (async (): Promise<McpOAuthStartResult> => ({ state: "pending", authUrl: AUTH_URL })),
  );
  const openUrl = vi.fn(async () => ({ ok: true as const }));
  const signOut = vi.fn(async (name: string) => {
    createMcpOAuthStore(getConfig().paths.stateDir).clear(name);
  });
  const hub = new IntegrationsOrchestrator(
    runtime,
    bus,
    undefined,
    undefined,
    undefined,
    opts.withoutSignIn ? {} : { startSignIn, openUrl, signOut },
  );
  return { hub, bus, addServerLive, refreshMcp, startSignIn, openUrl, signOut };
}

function monidRow(bus: ReturnType<typeof makeBus>): IntegrationRow {
  const synced = bus.actions.filter((a) => a.type === "integrations_synced");
  const rows = (synced.at(-1)?.rows ?? []) as IntegrationRow[];
  const row = rows.find((r) => r.id === "monid");
  if (!row) throw new Error("no monid row");
  return row;
}

function settled(bus: ReturnType<typeof makeBus>): { message?: string; error?: string } {
  const events = bus.actions.filter((a) => a.type === "integrations_action_settled");
  return (events.at(-1) ?? {}) as { message?: string; error?: string };
}

function monidServers() {
  return (getConfig().mcp?.servers ?? []).filter(
    (s) => s.transport.kind !== "stdio" && s.transport.url === MONID_URL,
  );
}

function saveToken(stateDir: string, name: string): void {
  createMcpOAuthStore(stateDir).update(name, MONID_URL, {
    tokens: { access_token: "at_test", token_type: "Bearer" },
  });
}

describe("IntegrationsOrchestrator — Monid (ATO-1630)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "integrations-monid-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("lists Monid as not connected, with no key field and a sign-in verb", () => {
    const { hub, bus } = makeHub();
    hub.refresh();
    const row = monidRow(bus);
    expect(row.level).toBe("not_configured");
    expect(row.fields).toEqual([]);
    expect(row.actions).toEqual([{ key: "s", id: "signin", label: "sign in with Monid" }]);
    expect(row.setupSteps?.length).toBeGreaterThan(0);
  });

  it("sign in adds the catalog card's server, then opens the browser", async () => {
    const { hub, bus, addServerLive, startSignIn, openUrl } = makeHub();
    await hub.runAction("monid", "signin");

    expect(settled(bus).error).toBeUndefined();
    expect(settled(bus).message).toMatch(/Monid server added/);
    expect(monidServers()).toHaveLength(1);
    expect(monidServers()[0]).toEqual(parseAddServerJson(buildMcpCatalogJson(findMcpCatalogEntry("monid")!)));
    expect(addServerLive).toHaveBeenCalledTimes(1);
    expect(startSignIn).toHaveBeenCalledWith("monid");
    expect(openUrl).toHaveBeenCalledWith(AUTH_URL);
  });

  it("pressing sign in again does not add a second server", async () => {
    const { hub, bus, addServerLive, startSignIn } = makeHub();
    await hub.runAction("monid", "signin");
    await hub.runAction("monid", "signin");

    expect(settled(bus).error).toBeUndefined();
    expect(settled(bus).message).not.toMatch(/added/);
    expect(monidServers()).toHaveLength(1);
    expect(getConfig().mcp?.servers.map((s) => s.name)).toEqual(["monid"]);
    expect(addServerLive).toHaveBeenCalledTimes(1);
    expect(startSignIn).toHaveBeenCalledTimes(2);
  });

  it("after the catalog card added Monid, sign in reuses that server", async () => {
    persistMcpServer(parseAddServerJson(buildMcpCatalogJson(findMcpCatalogEntry("monid")!)));
    const { hub, addServerLive, startSignIn } = makeHub();
    await hub.runAction("monid", "signin");

    expect(monidServers()).toHaveLength(1);
    expect(addServerLive).not.toHaveBeenCalled();
    expect(startSignIn).toHaveBeenCalledWith("monid");
  });

  it("reuses a Monid server the operator added under another name", async () => {
    persistMcpServer(
      parseAddServerJson(JSON.stringify({ mcpServers: { "my-monid": { url: MONID_URL } } })),
    );
    const { hub, startSignIn } = makeHub();
    await hub.runAction("monid", "signin");

    expect(getConfig().mcp?.servers.map((s) => s.name)).toEqual(["my-monid"]);
    expect(startSignIn).toHaveBeenCalledWith("my-monid");
  });

  it("a saved refresh token signs in without a browser", async () => {
    const { hub, bus, openUrl } = makeHub({ start: async () => ({ state: "signed_in" }) });
    await hub.runAction("monid", "signin");
    expect(settled(bus).message).toMatch(/Signed in to Monid/);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("prints the link when the browser cannot be opened", async () => {
    const { hub, bus, openUrl } = makeHub();
    openUrl.mockResolvedValueOnce({ ok: false, reason: "no display" } as never);
    await hub.runAction("monid", "signin");
    expect(settled(bus).message).toContain(AUTH_URL);
  });

  it("a sign-in that fails to start shows its reason and keeps the one server", async () => {
    const { hub, bus } = makeHub({
      start: async () => {
        throw new Error("Could not start sign-in: offline");
      },
    });
    await hub.runAction("monid", "signin");
    expect(settled(bus).error).toMatch(/offline/);
    expect(monidServers()).toHaveLength(1);
  });

  it("without the MCP tab's sign-in, says so and adds nothing", async () => {
    const { hub, bus } = makeHub({ withoutSignIn: true });
    await hub.runAction("monid", "signin");
    expect(settled(bus).error).toMatch(/\/mcp auth monid/);
    expect(monidServers()).toHaveLength(0);
  });

  it("reads signed in and sign-in expired from the MCP OAuth token store", () => {
    persistMcpServer(parseAddServerJson(buildMcpCatalogJson(findMcpCatalogEntry("monid")!)));
    saveToken(stateDir, "monid");
    expect(readMcpSignedIn(stateDir, getConfig().mcp?.servers)).toEqual(new Set(["monid"]));

    const up = makeHub({ states: [{ name: "monid", state: "up" }] });
    up.hub.refresh();
    expect(monidRow(up.bus)).toMatchObject({ level: "connected", detail: "signed in" });

    const expired = makeHub({ states: [{ name: "monid", state: "needs_auth" }] });
    expired.hub.refresh();
    expect(monidRow(expired.bus).level).toBe("error");
    expect(monidRow(expired.bus).detail).toMatch(/sign-in expired/);
  });

  it("disconnect shows only when signed in, forgets the sign-in and keeps the server", async () => {
    persistMcpServer(parseAddServerJson(buildMcpCatalogJson(findMcpCatalogEntry("monid")!)));
    const before = makeHub();
    before.hub.refresh();
    expect(monidRow(before.bus).actions.map((a) => a.id)).toEqual(["signin"]);

    saveToken(stateDir, "monid");
    const { hub, bus, signOut } = makeHub({ states: [{ name: "monid", state: "up" }] });
    hub.refresh();
    expect(monidRow(bus).actions).toContainEqual({ key: "x", id: "disconnect", label: "disconnect" });

    await hub.runAction("monid", "disconnect");
    expect(signOut).toHaveBeenCalledWith("monid");
    expect(settled(bus).error).toBeUndefined();
    expect(settled(bus).message).toMatch(/Disconnected from Monid/);
    expect(monidServers()).toHaveLength(1);
    expect(readMcpSignedIn(stateDir, getConfig().mcp?.servers)).toEqual(new Set());
    expect(monidRow(bus).actions.map((a) => a.id)).toEqual(["signin"]);
  });

  it("disconnect without the MCP tab's sign-out says so", async () => {
    const { hub, bus } = makeHub({ withoutSignIn: true });
    await hub.runAction("monid", "disconnect");
    expect(settled(bus).error).toMatch(/\/mcp signout monid/);
  });
});
