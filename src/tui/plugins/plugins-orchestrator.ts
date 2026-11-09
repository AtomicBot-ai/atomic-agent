import { getConfig } from "../../config/index.js";
import {
  loadPluginOverviews,
  removePlugin,
  resetPluginCache,
  setPluginCodeAllowed,
  setPluginEnabled,
  setPluginPartEnabled,
} from "../../plugins/index.js";
import type { TuiEventBus } from "../tui-app.js";

type Env = Readonly<Record<string, string | undefined>>;

export interface PluginsOrchestratorDeps {
  /** `<stateDir>`, shared with the desktop app. Defaults to the live config. */
  stateDir?: () => string;
  /** Environment for the "needs a key" check. Defaults to `process.env` (which already holds `.env`). */
  env?: () => Env;
}

/**
 * Only TUI module that reads or writes plugin state. It uses the same
 * writers as `atomic-agent plugin enable|disable|allow-code|deny-code|remove`
 * so the terminal, the CLI and the desktop app can never disagree about
 * what a switch means. The reducer and the view stay pure.
 *
 * Skills follow the switches on the next workspace refresh; MCP servers
 * start and stop with the agent, so the settled message says so.
 */
export class PluginsOrchestrator {
  private readonly stateDir: () => string;
  private readonly env: () => Env;

  constructor(
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
    deps: PluginsOrchestratorDeps = {},
  ) {
    this.stateDir = deps.stateDir ?? (() => getConfig().paths.stateDir);
    this.env = deps.env ?? (() => process.env);
  }

  refresh(): void {
    try {
      this.bus.emit({ type: "plugins_synced", rows: loadPluginOverviews(this.stateDir(), this.env()) });
    } catch (err) {
      this.bus.emit({ type: "plugins_action_settled", error: `could not read plugins: ${message(err)}` });
    }
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    await this.run(
      () => setPluginEnabled(this.stateDir(), name, enabled),
      name,
      enabled
        ? `${name} on. Its MCP servers start with the next agent start.`
        : `${name} off. Its MCP servers stop with the next agent start.`,
    );
  }

  async setPartEnabled(name: string, partId: string, enabled: boolean): Promise<void> {
    const restart = partId.startsWith("mcp:") ? " Takes effect with the next agent start." : "";
    await this.run(
      () => setPluginPartEnabled(this.stateDir(), name, partId, enabled),
      name,
      `${name} ${partId} ${enabled ? "on" : "off"}.${restart}`,
    );
  }

  /** Same write as `plugin allow-code` / `plugin deny-code`. */
  async setCodeAllowed(name: string, allow: boolean): Promise<void> {
    await this.run(
      () => setPluginCodeAllowed(this.stateDir(), name, allow),
      name,
      allow
        ? `${name} may run its local MCP servers, hooks and scripts. Servers start with the next agent start.`
        : `${name}'s local MCP servers, hooks and scripts are off.`,
    );
  }

  async remove(name: string): Promise<void> {
    await this.run(() => removePlugin(this.stateDir(), name), name, `Removed ${name}.`);
  }

  private async run(write: () => boolean, name: string, done: string): Promise<void> {
    this.bus.emit({ type: "plugins_action_started" });
    try {
      const found = write();
      resetPluginCache();
      this.bus.emit(
        found
          ? { type: "plugins_action_settled", message: done }
          : { type: "plugins_action_settled", error: `plugin not installed: ${name}` },
      );
    } catch (err) {
      this.bus.emit({ type: "plugins_action_settled", error: `${name}: ${message(err)}` });
    }
    this.refresh();
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
