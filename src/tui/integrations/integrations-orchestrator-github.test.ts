import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetConfigCache } from "../../config/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";

import { IntegrationsOrchestrator } from "./integrations-orchestrator.js";
import type { IntegrationRow } from "./integrations-panel-state.js";

const TOKEN = `ghp_${"A".repeat(36)}`;

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

function makeHub(deps: {
  whoami?: () => Promise<{
    login: string;
    name: string | null;
    scopes: string[];
  }>;
  ghToken?: () => Promise<string | null>;
}) {
  const bus = makeBus();
  const refreshMcp = vi.fn(async () => undefined);
  const runtime = {
    telegramChannel: null,
    discordChannel: null,
    mcpManager: { listStatuses: () => [] },
    refreshMcp,
  } as unknown as AgentRuntime;
  const hub = new IntegrationsOrchestrator(runtime, bus, undefined, {
    apiFactory: () => ({
      whoami:
        deps.whoami ??
        (async () => ({ login: "octo", name: null, scopes: ["repo"] })),
    }),
    readGhCliToken: deps.ghToken ?? (async () => null),
  });
  return { hub, bus, refreshMcp };
}

function githubRow(bus: ReturnType<typeof makeBus>): IntegrationRow {
  const synced = bus.actions.filter((a) => a.type === "integrations_synced");
  const rows = (synced.at(-1)?.rows ?? []) as IntegrationRow[];
  const row = rows.find((r) => r.id === "github");
  if (!row) throw new Error("no github row");
  return row;
}

function settled(bus: ReturnType<typeof makeBus>): {
  message?: string;
  error?: string;
} {
  const events = bus.actions.filter(
    (a) => a.type === "integrations_action_settled",
  );
  return (events.at(-1) ?? {}) as { message?: string; error?: string };
}

describe("IntegrationsOrchestrator — GitHub", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "integrations-github-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    delete process.env.GITHUB_TOKEN;
    resetConfigCache();
  });

  afterEach(() => {
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.GITHUB_TOKEN;
    resetConfigCache();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("lists GitHub as not configured with the import verb but no verify", () => {
    const { hub, bus } = makeHub({});
    hub.refresh();
    const row = githubRow(bus);
    expect(row.level).toBe("not_configured");
    expect(row.actions.map((a) => a.id)).toEqual(["import"]);
    expect(row.setupSteps?.length).toBeGreaterThan(0);
  });

  it("a saved token lands in .env and process.env and refreshes the catalog", async () => {
    const { hub, bus, refreshMcp } = makeHub({});
    await hub.saveField("github", "token", TOKEN);
    expect(settled(bus).error).toBeUndefined();
    expect(process.env.GITHUB_TOKEN).toBe(TOKEN);
    expect(readFileSync(join(stateDir, ".env"), "utf8")).toContain(
      `GITHUB_TOKEN=${TOKEN}`,
    );
    // The `github.*` descriptors are gated on the token, so the runtime
    // has to rebuild its catalog now, not on the next boot.
    expect(refreshMcp).toHaveBeenCalledTimes(1);
    const row = githubRow(bus);
    expect(row.level).toBe("configured");
    expect(row.actions.map((a) => a.id)).toEqual(["verify", "import"]);
    // Masked, never the token.
    expect(row.fields[0]?.display).not.toContain("ghp_");
  });

  it("rejects a paste that is not a token without writing anything", async () => {
    const { hub, bus, refreshMcp } = makeHub({});
    await hub.saveField("github", "token", "my-token-name");
    expect(settled(bus).error).toMatch(/Doesn't look like a GitHub token/);
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
    expect(refreshMcp).not.toHaveBeenCalled();
  });

  it("verify turns a saved token into a connected identity", async () => {
    const { hub, bus } = makeHub({
      whoami: async () => ({
        login: "octo",
        name: "Octo",
        scopes: ["repo", "workflow"],
      }),
    });
    await hub.saveField("github", "token", TOKEN);
    await hub.runAction("github", "verify");
    expect(settled(bus).message).toBe(
      "GitHub token works — connected as @octo",
    );
    const row = githubRow(bus);
    expect(row.level).toBe("connected");
    expect(row.detail).toBe("@octo · repo, workflow");
    // Connected: the walkthrough is no longer shown.
    expect(row.setupSteps).toBeUndefined();
  });

  it("verify failure becomes the row's error, and the token never leaks", async () => {
    const { hub, bus } = makeHub({
      whoami: async () => {
        throw new Error(`GitHub rejected the token (HTTP 401) ${TOKEN}`);
      },
    });
    await hub.saveField("github", "token", TOKEN);
    await hub.runAction("github", "verify");
    expect(settled(bus).error).toContain("HTTP 401");
    expect(settled(bus).error).not.toContain(TOKEN);
    const row = githubRow(bus);
    expect(row.level).toBe("error");
    expect(row.detail).not.toContain(TOKEN);
  });

  it("changing the token forgets what verify said about the old one", async () => {
    const { hub, bus } = makeHub({});
    await hub.saveField("github", "token", TOKEN);
    await hub.runAction("github", "verify");
    expect(githubRow(bus).level).toBe("connected");
    await hub.saveField("github", "token", `ghp_${"B".repeat(36)}`);
    expect(githubRow(bus).level).toBe("configured");
    await hub.clearField("github", "token");
    expect(githubRow(bus).level).toBe("not_configured");
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
  });

  it("import copies the gh CLI token through the same write path", async () => {
    const { hub, bus, refreshMcp } = makeHub({
      ghToken: async () => `gho_${"C".repeat(36)}`,
    });
    await hub.runAction("github", "import");
    expect(settled(bus).error).toBeUndefined();
    expect(settled(bus).message).toMatch(/imported from gh/);
    expect(process.env.GITHUB_TOKEN).toBe(`gho_${"C".repeat(36)}`);
    expect(refreshMcp).toHaveBeenCalledTimes(1);
    expect(githubRow(bus).level).toBe("configured");
  });

  it("import explains itself when gh has nothing", async () => {
    const { hub, bus } = makeHub({ ghToken: async () => null });
    await hub.runAction("github", "import");
    expect(settled(bus).error).toMatch(/gh auth login/);
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
  });

  it("import refuses junk from gh", async () => {
    const { hub, bus } = makeHub({ ghToken: async () => "not a token" });
    await hub.runAction("github", "import");
    expect(settled(bus).error).toMatch(/not a GitHub token/);
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
  });
});
