import {
  COMPOSIO_SERVER_NAME,
  clearComposioSession,
  resolveComposioServerConfig,
} from "../../composio/index.js";
import { AtomicMailService } from "../../atomic-mail/index.js";
import { getConfig } from "../../config/index.js";
import {
  applyAtomicMailField,
  runAtomicMailAction,
} from "./integrations-orchestrator-atomic-mail.js";
import {
  GITHUB_INTEGRATION_ID,
  GITHUB_TOKEN_FIELD,
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
  /** Push a token the hub has just written into the live channel. */
  adoptToken(): Promise<void>;
  /** Bring the channel up, or throw the channel's own reason. */
  ensureUpForPairing(): Promise<void>;
}

import {
  importGithubTokenFromGh,
  verifyGithubToken,
  type GithubHubDeps,
} from "./integrations-orchestrator-github.js";

export type { GithubHubDeps } from "./integrations-orchestrator-github.js";

/**
 * The only TUI module that touches credential storage and the live MCP
 * manager on behalf of the Integrations tab. The reducer and component
 * stay pure; every side effect (`.env` writes, `resetConfigCache`,
 * live server mount/unmount) is funnelled through here — mirroring the
 * other TUI orchestrators.
 */
export class IntegrationsOrchestrator {
  /**
   * The last `verify` answer for GitHub, kept for the life of the
   * process. A token has no channel or server to report liveness, so
   * without this the badge could never say more than "saved".
   */
  private githubIdentity: string | null = null;
  private githubVerifyError: string | null = null;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
    /**
     * Telegram's own orchestrator. The hub delegates rather than
     * reimplements: pairing windows, token writes and channel restarts
     * are already correct there, and a second copy would drift.
     */
    private readonly telegram?: TelegramActions,
    private readonly github: GithubHubDeps = {},
    /** The agent's inbox. Constructed lazily so tests can inject one. */
    private readonly atomicMail: AtomicMailService = new AtomicMailService(),
  ) {}

  /** The one registration in flight, so a second `r` joins it instead of making a second inbox. */
  private readonly registration: { inFlight: Promise<void> | null } = {
    inFlight: null,
  };

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
    const channelErrors = new Map<string, string>();
    const telegram = this.runtime.telegramChannel;
    if (telegram) {
      channelStates.set("telegram", telegram.state());
      const err = telegram.lastError();
      if (err) channelErrors.set("telegram", err);
    }
    const discord = this.runtime.discordChannel;
    if (discord) {
      channelStates.set("discord", discord.state());
      const err = discord.lastError();
      if (err) channelErrors.set("discord", err);
    }
    const verifiedIdentities = new Map<string, string>();
    const verifyErrors = new Map<string, string>();
    if (this.githubIdentity !== null) {
      verifiedIdentities.set(GITHUB_INTEGRATION_ID, this.githubIdentity);
    }
    if (this.githubVerifyError !== null) {
      verifyErrors.set(GITHUB_INTEGRATION_ID, this.githubVerifyError);
    }
    // Atomic Mail runs no loop; its "state" is whether the owner typed
    // the code back, which lives in config.
    if (config.atomicMail.ownerVerifiedAt)
      channelStates.set("atomic-mail", "verified");
    else if (config.atomicMail.pendingVerification)
      channelStates.set("atomic-mail", "pending");
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
        channelErrors,
        verifiedIdentities,
        verifyErrors,
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
        ...(field.readonly ? { readonly: true } : {}),
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
        // Only while it is not working yet: a connected integration
        // does not need to be told how to connect.
        ...(descriptor.setupSteps === undefined || status.level === "connected"
          ? {}
          : { setupSteps: descriptor.setupSteps }),
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
        // A pairing window only claims a DM while the poller is
        // running, so start the channel first and let a failure
        // surface as this action's error. Announcing "DM your bot now"
        // in front of a channel that never came up is how an operator
        // ends up messaging a bot nothing is listening to.
        await this.telegram.ensureUpForPairing();
        // Fire-and-forget from here: the window runs for its full
        // timeout and the outcome lands through the channel's own
        // status stream, so awaiting it would freeze the pane for a
        // minute.
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
    if (integrationId === GITHUB_INTEGRATION_ID) {
      if (actionId === "verify") return this.verifyGithub();
      if (actionId === "import") return this.importGithubTokenFromGh();
    }
    if (integrationId === "atomic-mail") {
      return runAtomicMailAction(this.atomicMail, actionId, this.registration, {
        onSettled: (message, error) => {
          this.bus.emit({
            type: "integrations_action_settled",
            ...(message ? { message } : {}),
            ...(error ? { error } : {}),
          });
          this.refresh();
        },
      });
    }
    throw new Error(`unknown action ${actionId} for ${integrationId}`);
  }

  private async verifyGithub(): Promise<string> {
    const outcome = await verifyGithubToken(this.github);
    this.githubIdentity = outcome.identity;
    this.githubVerifyError = outcome.error;
    if (outcome.error !== null) throw new Error(outcome.error);
    return outcome.message;
  }

  private async importGithubTokenFromGh(): Promise<string> {
    const token = await importGithubTokenFromGh(this.github);
    const descriptor = findIntegration(GITHUB_INTEGRATION_ID);
    const field = descriptor?.fields.find((f) => f.key === GITHUB_TOKEN_FIELD);
    if (!descriptor || !field)
      throw new Error("GitHub integration unavailable");
    const cfg = getConfig();
    writeFieldValue(
      cfg.paths.stateDir,
      field,
      token,
      process.env,
      cfg.paths.userConfigFile,
    );
    await this.applyGithub();
    return "GitHub token imported from gh — press v to verify";
  }

  /**
   * A token change invalidates whatever `verify` said about the old
   * one, and the tool catalog has to gain or lose the `github.*`
   * descriptors — `refreshMcp()` is the runtime's one "rebuild the
   * catalog" verb, so a token save rides on it.
   */
  private async applyGithub(): Promise<void> {
    this.githubIdentity = null;
    this.githubVerifyError = null;
    await this.runtime.refreshMcp?.();
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
        throw new IntegrationSecretError(
          `unknown integration ${integrationId}`,
        );
      }
      const field = descriptor.fields.find((f) => f.key === fieldKey);
      if (!field) {
        throw new IntegrationSecretError(`unknown field ${fieldKey}`);
      }
      const cfg = getConfig();
      if (integrationId === "atomic-mail") {
        // Acts *before* the write: the owner address must not land in
        // config unless the code mail went out — the service writes
        // both atomically — and a code is never written at all.
        const message = await applyAtomicMailField(
          this.atomicMail,
          field,
          value,
        );
        if (message !== null) {
          this.bus.emit({ type: "integrations_action_settled", message });
          this.refresh();
          return;
        }
      }
      writeFieldValue(
        cfg.paths.stateDir,
        field,
        value,
        process.env,
        cfg.paths.userConfigFile,
      );
      if (integrationId === "atomic-mail" && field.key === "apiKey") {
        const { address } = await this.atomicMail.reconnect();
        this.bus.emit({
          type: "integrations_action_settled",
          message: address
            ? `Inbox connected: ${address}`
            : "Inbox key cleared",
        });
        this.refresh();
        return;
      }
      if (integrationId === "composio") {
        await this.applyComposio(value !== null);
      }
      if (integrationId === GITHUB_INTEGRATION_ID) {
        await this.applyGithub();
      }
      // A channel resolves its token and its kill switch when it is
      // constructed, so a saved value that never reaches the running
      // channel looks to the operator like the setting did nothing.
      // Each field goes to the mutator that actually owns it;
      // `restart()` is not one of them -- it only re-starts a channel
      // that was already `up`.
      if (integrationId === "telegram" && this.telegram) {
        if (field.key === "enabled") {
          await this.telegram.setEnabled(value === "on");
        } else if (field.key === "botToken") {
          await this.telegram.adoptToken();
        } else {
          const channel = this.runtime.telegramChannel;
          if (field.key === "ownerUserId" && channel) {
            await channel.setOwnerUserId(value === null ? null : Number(value));
          } else {
            await this.telegram.restart();
          }
        }
      }
      if (integrationId === "discord") {
        const channel = this.runtime.discordChannel;
        if (channel) {
          if (field.key === "ownerUserId") {
            channel.setOwnerUserId(value);
          }
          if (field.key === "enabled") {
            await channel.setEnabled(value === "on");
          } else {
            // Token or owner change: the gateway captured the old one,
            // so rebuild it -- but only if the operator wants it up.
            await channel.stop();
            if (getConfig().discord.enabled) await channel.setEnabled(true);
          }
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
