import {
  COMPOSIO_SERVER_NAME,
  clearComposioSession,
  resolveComposioServerConfig,
} from "../../composio/index.js";
import { getConfig } from "../../config/index.js";
import {
  IntegrationSecretError,
  displayFieldValue,
  findIntegration,
  listIntegrations,
  presentFieldKeys,
  readFieldValue,
  writeFieldValue,
} from "../../integrations/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { TuiEventBus } from "../tui-app.js";
import type {
  IntegrationRow,
  IntegrationFieldRow,
} from "./integrations-panel-state.js";

/** The slice of `TuiTelegramOrchestrator` the hub drives. */
export interface TelegramActions {
  startPairing(timeoutMs?: number): Promise<void>;
  restart(): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
}

/**
 * The only TUI module that touches credential storage and the live MCP
 * manager on behalf of the Integrations tab. The reducer and component
 * stay pure; every side effect (`.env` writes, `resetConfigCache`,
 * live server mount/unmount) is funnelled through here — mirroring the
 * other TUI orchestrators.
 */
export class IntegrationsOrchestrator {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
    /**
     * Telegram's own orchestrator. The hub delegates rather than
     * reimplements: pairing windows, token writes and channel restarts
     * are already correct there, and a second copy would drift.
     */
    private readonly telegram?: TelegramActions,
  ) {}

  /** Rebuild every row from credential presence + live server state. */
  refresh(): void {
    this.bus.emit({ type: "integrations_synced", rows: this.buildRows() });
  }

  private buildRows(): IntegrationRow[] {
    const config = getConfig();
    const mcpServerStates = new Map<string, string>();
    for (const status of this.runtime.mcpManager.listStatuses()) {
      mcpServerStates.set(status.name, status.state);
    }
    // Channel-backed integrations (Telegram) report liveness the same
    // way, so a token that is saved but not running reads differently
    // from one that is.
    const channelStates = new Map<string, string>();
    const telegram = this.runtime.telegramChannel;
    if (telegram) channelStates.set("telegram", telegram.state());
    const discord = this.runtime.discordChannel;
    if (discord) channelStates.set("discord", discord.state());
    return listIntegrations().map((descriptor) => {
      const present = presentFieldKeys(
        descriptor,
        process.env,
        config as unknown as Record<string, unknown>,
      );
      const statusCtx = {
        presentFields: present,
        configured: descriptor.fields
          .filter((f) => f.required)
          .every((f) => present.has(f.key)),
        mcpServerStates,
        channelStates,
      };
      const status = descriptor.status(statusCtx);
      const fields: IntegrationFieldRow[] = descriptor.fields.map((field) => ({
        key: field.key,
        label: field.label,
        kind: field.kind ?? "text",
        display: displayFieldValue(
          field,
          readFieldValue(
            field,
            process.env,
            config as unknown as Record<string, unknown>,
          ),
        ),
        present: present.has(field.key),
        ...(field.help === undefined ? {} : { help: field.help }),
      }));
      return {
        id: descriptor.id,
        label: descriptor.label,
        summary: descriptor.summary,
        level: status.level,
        ...(status.detail === undefined ? {} : { detail: status.detail }),
        ...(descriptor.docsUrl === undefined
          ? {}
          : { docsUrl: descriptor.docsUrl }),
        appliesLive: descriptor.appliesLive,
        fields,
        actions: (descriptor.actions ?? [])
          .filter((a) => a.available?.(statusCtx) !== false)
          .map((a) => ({ key: a.key, id: a.id, label: a.label })),
      };
    });
  }

  /**
   * Run a descriptor action (pair, restart). Errors surface as a
   * sticky line rather than throwing into the Ink tree.
   */
  async runAction(integrationId: string, actionId: string): Promise<void> {
    this.bus.emit({ type: "integrations_action_started" });
    try {
      const message = await this.dispatchAction(integrationId, actionId);
      this.bus.emit({ type: "integrations_action_settled", message });
    } catch (err) {
      this.bus.emit({
        type: "integrations_action_settled",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.refresh();
  }

  private async dispatchAction(
    integrationId: string,
    actionId: string,
  ): Promise<string> {
    if (integrationId === "telegram") {
      if (!this.telegram) throw new Error("Telegram controls unavailable");
      if (actionId === "pair") {
        // Fire-and-forget: the window runs for its full timeout and the
        // outcome lands through the channel's own status stream, so
        // awaiting it here would freeze the pane for a minute.
        void this.telegram.startPairing();
        return "Pairing — DM your bot now; the next sender becomes the owner.";
      }
      if (actionId === "restart") {
        await this.telegram.restart();
        return "Telegram channel restarted";
      }
    }
    if (integrationId === "discord" && actionId === "restart") {
      const channel = this.runtime.discordChannel;
      if (!channel) throw new Error("Discord channel unavailable");
      await channel.stop();
      await channel.start();
      return "Discord channel restarted";
    }
    throw new Error(`unknown action ${actionId} for ${integrationId}`);
  }

  /** Flip a boolean field to the opposite of its current value. */
  async toggleField(integrationId: string, fieldKey: string): Promise<void> {
    const descriptor = findIntegration(integrationId);
    const field = descriptor?.fields.find((f) => f.key === fieldKey);
    if (!descriptor || !field) return;
    const current = readFieldValue(
      field,
      process.env,
      getConfig() as unknown as Record<string, unknown>,
    );
    await this.mutate(
      integrationId,
      fieldKey,
      current === "on" ? "off" : "on",
      current === "on" ? "off" : "on",
    );
  }

  /** Persist one field, then apply the change to the live runtime. */
  async saveField(
    integrationId: string,
    fieldKey: string,
    value: string,
  ): Promise<void> {
    await this.mutate(integrationId, fieldKey, value, "saved");
  }

  /** Clear one field, then unmount whatever it was powering. */
  async clearField(integrationId: string, fieldKey: string): Promise<void> {
    await this.mutate(integrationId, fieldKey, null, "cleared");
  }

  private async mutate(
    integrationId: string,
    fieldKey: string,
    value: string | null,
    verb: string,
  ): Promise<void> {
    this.bus.emit({ type: "integrations_action_started" });
    try {
      const descriptor = findIntegration(integrationId);
      if (!descriptor) {
        throw new IntegrationSecretError(`unknown integration ${integrationId}`);
      }
      const field = descriptor.fields.find((f) => f.key === fieldKey);
      if (!field) {
        throw new IntegrationSecretError(`unknown field ${fieldKey}`);
      }
      const cfg = getConfig();
      writeFieldValue(
        cfg.paths.stateDir,
        field,
        value,
        process.env,
        cfg.paths.userConfigFile,
      );
      if (integrationId === "composio") {
        await this.applyComposio(value !== null);
      }
      // A channel resolves its token and switches at start(), so a
      // saved value that never reaches a running channel would look
      // like the setting did nothing.
      if (integrationId === "telegram" && this.telegram) {
        if (field.key === "enabled") {
          await this.telegram.setEnabled(value === "on");
        } else {
          await this.telegram.restart();
        }
      }
      if (integrationId === "discord") {
        const channel = this.runtime.discordChannel;
        if (channel) {
          await channel.stop();
          if (getConfig().discord.enabled) await channel.start();
        }
      }
      this.bus.emit({
        type: "integrations_action_settled",
        message: `${descriptor.label} ${field.label} ${verb}`,
      });
    } catch (err) {
      this.bus.emit({
        type: "integrations_action_settled",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.refresh();
  }

  /**
   * Mount or unmount the Composio MCP server without a restart.
   *
   * The cached tool-router session is dropped on every key change: a
   * session belongs to the key that created it, so reusing it across a
   * key swap would silently keep talking to the old account.
   */
  private async applyComposio(configured: boolean): Promise<void> {
    const config = getConfig();
    await this.runtime.mcpManager.removeServerLive(COMPOSIO_SERVER_NAME);
    clearComposioSession(config.paths.userConfigFile);
    if (configured) {
      const server = await resolveComposioServerConfig({
        composio: getConfig().composio,
        userConfigFile: config.paths.userConfigFile,
      });
      if (server) await this.runtime.mcpManager.addServerLive(server);
    }
    await this.runtime.refreshMcp?.();
  }
}
