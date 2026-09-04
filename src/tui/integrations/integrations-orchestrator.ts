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
  ) {}

  /** Rebuild every row from credential presence + live server state. */
  refresh(): void {
    this.bus.emit({ type: "integrations_synced", rows: this.buildRows() });
  }

  private buildRows(): IntegrationRow[] {
    const mcpServerStates = new Map<string, string>();
    for (const status of this.runtime.mcpManager.listStatuses()) {
      mcpServerStates.set(status.name, status.state);
    }
    return listIntegrations().map((descriptor) => {
      const present = presentFieldKeys(descriptor);
      const status = descriptor.status({
        presentFields: present,
        configured: descriptor.fields
          .filter((f) => f.required)
          .every((f) => present.has(f.key)),
        mcpServerStates,
      });
      const fields: IntegrationFieldRow[] = descriptor.fields.map((field) => ({
        key: field.key,
        label: field.label,
        display: displayFieldValue(field, readFieldValue(field)),
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
      };
    });
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
      writeFieldValue(getConfig().paths.stateDir, field, value);
      if (integrationId === "composio") {
        await this.applyComposio(value !== null);
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
