import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installPluginFromDir, readPluginState } from "../../plugins/index.js";
import { writeClaudePlugin } from "../../plugins/plugin-test-helpers.js";
import { PluginsOrchestrator } from "./plugins-orchestrator.js";

interface Emitted {
  type: string;
  [key: string]: unknown;
}

function makeBus() {
  const actions: Emitted[] = [];
  return {
    actions,
    bus: {
      subscribe: () => () => {},
      emit: (action: unknown) => {
        actions.push(action as Emitted);
      },
    },
  };
}

describe("PluginsOrchestrator", () => {
  let base: string;
  let stateDir: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "plugins-orch-"));
    stateDir = join(base, "state");
    installPluginFromDir(stateDir, writeClaudePlugin(join(base, "src"), { mcp: { gh: { command: "npx", env: { T: "${T}" } } } }));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function make() {
    const { actions, bus } = makeBus();
    const orch = new PluginsOrchestrator(bus as never, { stateDir: () => stateDir, env: () => ({}) });
    return { actions, orch };
  }

  it("syncs overviews with the needs-a-key mark from the given env", () => {
    const { actions, orch } = make();
    orch.refresh();
    const synced = actions.find((a) => a.type === "plugins_synced") as Emitted & { rows: Array<{ name: string; needsKey: boolean }> };
    expect(synced.rows.map((r) => [r.name, r.needsKey])).toEqual([["demo", true]]);
  });

  it("writes through the shared plugin writers and re-syncs", async () => {
    const { actions, orch } = make();
    await orch.setEnabled("demo", false);
    await orch.setPartEnabled("demo", "mcp:gh", false);
    await orch.setCodeAllowed("demo", true);
    const rec = readPluginState(stateDir).plugins.demo;
    expect(rec).toMatchObject({ enabled: false, runsCodeAccepted: true, disabledParts: ["mcp:gh"] });
    expect(actions.filter((a) => a.type === "plugins_action_settled").map((a) => a.message)).toEqual([
      "demo off. Its MCP servers stop with the next agent start.",
      "demo mcp:gh off. Takes effect with the next agent start.",
      "demo may run its local MCP servers, hooks and scripts and receive your keys. Servers start with the next agent start.",
    ]);
    expect(actions.at(-1)?.type).toBe("plugins_synced");
  });

  it("removes a plugin and reports an unknown one as an error", async () => {
    const { actions, orch } = make();
    await orch.remove("demo");
    expect(readPluginState(stateDir).plugins.demo).toBeUndefined();
    await orch.remove("demo");
    expect(actions.filter((a) => a.type === "plugins_action_settled").map((a) => a.error ?? a.message)).toEqual([
      "Removed demo.",
      "plugin not installed: demo",
    ]);
  });
});
