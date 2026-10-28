import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  USER_CONFIG_DEFAULTS,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../../config/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";

import { IntegrationsOrchestrator } from "./integrations-orchestrator.js";
import type { IntegrationRow } from "./integrations-panel-state.js";

const KEY = "0b1c2d3e-aaaa-bbbb-cccc-0123456789ab";

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

function makeHub() {
  const bus = makeBus();
  const refreshMcp = vi.fn(async () => undefined);
  const runtime = {
    telegramChannel: null,
    discordChannel: null,
    mcpManager: { listStatuses: () => [] },
    refreshMcp,
  } as unknown as AgentRuntime;
  const hub = new IntegrationsOrchestrator(runtime, bus);
  return { hub, bus, refreshMcp };
}

function exaRow(bus: ReturnType<typeof makeBus>): IntegrationRow {
  const synced = bus.actions.filter((a) => a.type === "integrations_synced");
  const rows = (synced.at(-1)?.rows ?? []) as IntegrationRow[];
  const row = rows.find((r) => r.id === "exa");
  if (!row) throw new Error("no exa row");
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

describe("IntegrationsOrchestrator — Web search (Exa), ATO-345", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "integrations-exa-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    delete process.env.EXA_API_KEY;
    resetConfigCache();
  });

  afterEach(() => {
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.EXA_API_KEY;
    resetConfigCache();
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("lists the row as not set, with the steps to get a key", () => {
    const { hub, bus } = makeHub();
    hub.refresh();
    const row = exaRow(bus);
    expect(row.label).toBe("Web search (Exa)");
    expect(row.level).toBe("not_configured");
    expect(row.appliesLive).toBe(true);
    expect(row.setupSteps?.length).toBeGreaterThan(0);
    expect(row.fields[0]?.present).toBe(false);
    // The panel masks a secret field's edit buffer off this flag.
    expect(row.fields[0]?.secret).toBe(true);
  });

  it("a saved key lands in .env and process.env, and the row shows it set but masked", async () => {
    const { hub, bus } = makeHub();
    await hub.saveField("exa", "apiKey", KEY);

    expect(settled(bus).error).toBeUndefined();
    expect(settled(bus).message).toBe(
      "Exa key saved. The next web search uses it, no restart needed.",
    );
    // process.env is what the Exa provider reads on every search.
    expect(process.env.EXA_API_KEY).toBe(KEY);
    expect(readFileSync(join(stateDir, ".env"), "utf8")).toContain(
      `EXA_API_KEY=${KEY}`,
    );
    const row = exaRow(bus);
    expect(row.level).toBe("configured");
    expect(row.fields[0]?.present).toBe(true);
    // Masked, never the key.
    expect(row.fields[0]?.display).not.toContain(KEY.slice(0, 8));
    expect(JSON.stringify(bus.actions)).not.toContain(KEY);
  });

  it("clearing the key removes it and the row reads not set again", async () => {
    const { hub, bus } = makeHub();
    await hub.saveField("exa", "apiKey", KEY);
    await hub.clearField("exa", "apiKey");

    expect(process.env.EXA_API_KEY).toBeUndefined();
    // The writer unlinks a .env the removal left empty.
    const envFile = join(stateDir, ".env");
    if (existsSync(envFile)) {
      expect(readFileSync(envFile, "utf8")).not.toContain(KEY);
    }
    expect(settled(bus).message).toMatch(/cleared/);
    expect(exaRow(bus).level).toBe("not_configured");
  });

  function writeSearchConfig(
    edit: (search: (typeof USER_CONFIG_DEFAULTS)["web"]["search"]) => void,
  ): void {
    const config = structuredClone(USER_CONFIG_DEFAULTS);
    edit(config.web.search);
    writeUserConfigFileSync(join(stateDir, "config.json"), config);
    resetConfigCache();
  }

  it("says a key saved as EXA_API_KEY is not used when web search reads another variable", async () => {
    writeSearchConfig((search) => {
      search.exa.apiKeyEnv = "MY_EXA";
    });
    const { hub, bus } = makeHub();
    await hub.saveField("exa", "apiKey", KEY);

    expect(settled(bus).message).toBe(
      "Exa key saved, but web search reads MY_EXA (web.search.exa.apiKeyEnv), not EXA_API_KEY.",
    );
    expect(exaRow(bus).detail).toBe(
      "key saved, but web search reads MY_EXA (web.search.exa.apiKeyEnv), not EXA_API_KEY",
    );
  });

  it("does not promise the next search uses the key when Exa is not in the chain", async () => {
    writeSearchConfig((search) => {
      search.provider = "duckduckgo";
      search.fallback = [];
    });
    const { hub, bus } = makeHub();
    await hub.saveField("exa", "apiKey", KEY);

    expect(settled(bus).message).not.toMatch(/next web search uses it/);
    expect(settled(bus).message).toBe(
      "Exa key saved, but web search is set to duckduckgo; Exa is used only when it is web.search.provider or in web.search.fallback.",
    );
    expect(exaRow(bus).detail).toMatch(/set to duckduckgo/);
  });

  it("rejects a paste with a space without writing anything", async () => {
    const { hub, bus } = makeHub();
    await hub.saveField("exa", "apiKey", "my exa key");
    expect(settled(bus).error).toMatch(/no spaces/);
    expect(process.env.EXA_API_KEY).toBeUndefined();
  });
});
