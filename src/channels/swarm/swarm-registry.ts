/**
 * The swarm: every extra Telegram / Discord bot running on this runtime
 * beside the primary `config.telegram` / `config.discord` channels.
 *
 * One `SwarmRegistry` per runtime owns the unit list and one channel
 * object per unit. Units are constructed unconditionally (so the Swarm
 * tab can show them) and started only when `enabled` and a token is
 * present — the same lifecycle contract as the primary channels. Every
 * unit gets its own lockfile, session map and `.env` token key, so two
 * bots never share a session or a setting.
 *
 * Adding, editing and removing units goes through here, never through
 * the config file directly: the registry persists the change, then
 * reconciles the live channel (start / stop / rebuild) so the TUI and
 * the config never disagree.
 */

import { rmSync } from "node:fs";
import { resolve } from "node:path";

import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { ApprovalRouter } from "../../approval/approval-router.js";
import type { AtomicAgentConfig, SwarmUnitConfig } from "../../config/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { ChannelStatus } from "../../runtime/channel-status.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { DiscordChannel } from "../discord/discord-channel.js";
import type { WebSocketLike } from "../discord/discord-gateway-transport.js";
import { DiscordLockfile } from "../discord/discord-lockfile.js";
import type { PairingOutcome, PairingStateSnapshot } from "../telegram/telegram-channel.js";
import { TelegramChannel, type BotFactory } from "../telegram/telegram-channel.js";
import { TelegramLockfile } from "../telegram/telegram-lockfile.js";
import {
  readSwarmUnitToken,
  slugForUnit,
  tokenEnvForUnit,
  writeSwarmUnitToken,
  writeSwarmUnits,
} from "./swarm-settings.js";

export type SwarmUnitKind = SwarmUnitConfig["kind"];

export interface SwarmUnit {
  readonly config: SwarmUnitConfig;
  readonly channel: TelegramChannel | DiscordChannel;
}

/** What the TUI needs to draw one row. */
export interface SwarmUnitView {
  id: string;
  kind: SwarmUnitKind;
  label: string;
  role: string;
  enabled: boolean;
  hasToken: boolean;
  ownerUserId: string | null;
  state: ChannelStatus["state"];
  lastError: string | null;
  /** Bot username once the channel has probed it. */
  botUsername: string | null;
  /** Telegram only. */
  pairing: PairingStateSnapshot | null;
}

export interface NewSwarmUnit {
  kind: SwarmUnitKind;
  label: string;
  role?: string;
  token?: string | null;
  ownerUserId?: string | null;
  /** Default `true`: a freshly added bot should come up if it has a token. */
  enabled?: boolean;
}

export interface SwarmUnitPatch {
  label?: string;
  role?: string;
  ownerUserId?: string | null;
  enabled?: boolean;
}

export interface SwarmRegistryDeps {
  runtime: AgentRuntime;
  config: AtomicAgentConfig;
  logger: StructuredLogger;
  approvals: ApprovalGate;
  approvalRouter: ApprovalRouter;
  stateDir: string;
  userConfigFile: string;
  /** Test seams. */
  telegramBotFactory?: BotFactory;
  createDiscordSocket?: (url: string) => WebSocketLike;
  discordApiBaseUrl?: string;
}

export class SwarmRegistry {
  private readonly units = new Map<string, SwarmUnit>();
  private readonly listeners = new Set<() => void>();
  private stopped = false;

  constructor(private readonly deps: SwarmRegistryDeps) {
    for (const unit of deps.config.swarm.units) {
      this.units.set(unit.id, this.construct(unit));
    }
  }

  list(): SwarmUnit[] {
    return [...this.units.values()];
  }

  get(id: string): SwarmUnit | undefined {
    return this.units.get(id);
  }

  /** Rows for the Swarm tab, in config order. */
  views(): SwarmUnitView[] {
    return this.list().map((u) => viewOf(u));
  }

  /** Subscribe to membership / settings changes (not to channel state). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Start every enabled unit that has a token. Bootstrap calls it
   * fire-and-forget; tests await it.
   */
  async startEnabled(): Promise<void> {
    await Promise.all(
      [...this.units.values()]
        .filter((u) => u.config.enabled && readSwarmUnitToken(u.config.tokenEnv) !== null)
        .map((u) => this.startUnit(u)),
    );
  }

  /**
   * Add a bot. Generates the id and `.env` key from the label, stores
   * the token (if any), persists the unit and brings it up when enabled
   * and a token is present. Returns the live unit.
   */
  async add(input: NewSwarmUnit): Promise<SwarmUnit> {
    const label = input.label.trim();
    if (label.length === 0) throw new Error("a bot needs a label");
    const id = slugForUnit(label, new Set(this.units.keys()));
    const tokenEnv = tokenEnvForUnit(input.kind, id);
    const token = input.token?.trim() || null;
    if (token !== null) {
      writeSwarmUnitToken(this.paths(), tokenEnv, token);
    }
    const config: SwarmUnitConfig = {
      id,
      kind: input.kind,
      label,
      role: (input.role ?? "").trim(),
      enabled: input.enabled ?? true,
      tokenEnv,
      ownerUserId: normaliseOwner(input.ownerUserId),
    };
    const unit = this.construct(config);
    this.units.set(id, unit);
    this.persist();
    this.deps.logger.info("swarm: unit added", { id, kind: input.kind, hasToken: token !== null });
    if (config.enabled && token !== null) await this.startUnit(unit);
    this.emit();
    return unit;
  }

  /** Change label / role / owner / kill switch. Owner and switch reach the live channel. */
  async update(id: string, patch: SwarmUnitPatch): Promise<SwarmUnit> {
    const unit = this.require(id);
    const next: SwarmUnitConfig = {
      ...unit.config,
      ...(patch.label !== undefined ? { label: patch.label.trim() || unit.config.label } : {}),
      ...(patch.role !== undefined ? { role: patch.role.trim() } : {}),
      ...(patch.ownerUserId !== undefined
        ? { ownerUserId: normaliseOwner(patch.ownerUserId) }
        : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    };
    const updated: SwarmUnit = { config: next, channel: unit.channel };
    this.units.set(id, updated);
    this.persist();
    if (patch.ownerUserId !== undefined) {
      if (unit.channel instanceof TelegramChannel) {
        // The channel persists through the sink, which lands back here
        // via `applyChannelPatch`; the config above is already current,
        // so this only refreshes the live mirror (and restarts when up).
        await unit.channel.setOwnerUserId(
          next.ownerUserId === null ? null : Number(next.ownerUserId),
        );
      } else {
        unit.channel.setOwnerUserId(next.ownerUserId);
      }
    }
    if (patch.enabled !== undefined) {
      if (patch.enabled) {
        if (readSwarmUnitToken(next.tokenEnv) !== null) await this.startUnit(updated);
      } else {
        await this.stopUnit(updated);
      }
    }
    this.emit();
    return updated;
  }

  /**
   * Store a new token (or clear it). Telegram re-reads the token live;
   * Discord fixes its token at construction, so its channel is rebuilt.
   */
  async setToken(id: string, token: string | null): Promise<SwarmUnit> {
    const unit = this.require(id);
    const trimmed = token?.trim() || null;
    if (unit.channel instanceof TelegramChannel) {
      // Persists via the unit's sink and restarts when up.
      await unit.channel.setToken(trimmed);
      if (trimmed !== null && unit.config.enabled && unit.channel.state() !== "up") {
        await this.startUnit(unit);
      }
      this.emit();
      return unit;
    }
    writeSwarmUnitToken(this.paths(), unit.config.tokenEnv, trimmed);
    await this.stopUnit(unit);
    const rebuilt: SwarmUnit = { config: unit.config, channel: this.construct(unit.config).channel };
    this.units.set(id, rebuilt);
    if (trimmed !== null && unit.config.enabled) await this.startUnit(rebuilt);
    this.emit();
    return rebuilt;
  }

  /** Stop the bot, forget its token, drop it from config and delete its session map. */
  async remove(id: string): Promise<void> {
    const unit = this.require(id);
    await this.stopUnit(unit);
    this.units.delete(id);
    this.persist();
    try {
      writeSwarmUnitToken(this.paths(), unit.config.tokenEnv, null);
    } catch (err) {
      this.deps.logger.warn("swarm: could not clear unit token", {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Sessions stay in the shared store; only the chat→session map goes.
    rmSync(this.pointerPath(unit.config), { force: true });
    this.deps.logger.info("swarm: unit removed", { id });
    this.emit();
  }

  async restart(id: string): Promise<void> {
    const unit = this.require(id);
    await this.stopUnit(unit);
    if (unit.config.enabled) await this.startUnit(unit);
    this.emit();
  }

  /** Telegram only: open a pairing window on the unit's bot. */
  async startPairing(id: string, timeoutMs?: number): Promise<PairingOutcome | null> {
    const unit = this.require(id);
    if (!(unit.channel instanceof TelegramChannel)) {
      throw new Error("only Telegram bots pair by DM; set the Discord owner id directly");
    }
    if (unit.channel.state() !== "up") {
      if (readSwarmUnitToken(unit.config.tokenEnv) === null) {
        throw new Error("set a bot token first");
      }
      await this.startUnit(unit);
      if (unit.channel.state() !== "up") {
        throw new Error(unit.channel.lastError() ?? "channel is not up");
      }
    }
    const outcome = await unit.channel.startPairing(timeoutMs);
    this.emit();
    return outcome;
  }

  cancelPairing(id: string): void {
    const unit = this.require(id);
    if (unit.channel instanceof TelegramChannel) unit.channel.cancelPairing();
  }

  /** Shutdown: stop every unit. Idempotent. */
  async stopAll(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const unit of this.units.values()) await this.stopUnit(unit);
  }

  // ---------------------------------------------------------------------

  private construct(config: SwarmUnitConfig): SwarmUnit {
    const { deps } = this;
    if (config.kind === "telegram") {
      const channel = new TelegramChannel({
        runtime: deps.runtime,
        config: deps.config,
        logger: deps.logger,
        token: readSwarmUnitToken(config.tokenEnv),
        ownerUserId: config.ownerUserId === null ? null : Number(config.ownerUserId),
        lock: new TelegramLockfile(resolve(deps.stateDir, `telegram-${config.id}.lock`)),
        sessionPointerPath: this.pointerPath(config),
        settings: {
          writeSettings: (patch) => this.applyChannelPatch(config.id, patch),
          writeToken: (token) =>
            writeSwarmUnitToken(this.paths(), this.tokenEnvOf(config.id), token),
        },
        ...(deps.telegramBotFactory ? { botFactory: deps.telegramBotFactory } : {}),
      });
      return { config, channel };
    }
    const channel = new DiscordChannel({
      runtime: deps.runtime,
      logger: deps.logger,
      approvals: deps.approvals,
      approvalRouter: deps.approvalRouter,
      // One inbox per unit: two bots receiving files at the same moment
      // must not write into the same directory.
      inboxDir: resolve(deps.stateDir, "inbox", "discord", config.id),
      enabled: config.enabled,
      ownerUserId: config.ownerUserId,
      token: readSwarmUnitToken(config.tokenEnv),
      sessionPointerPath: this.pointerPath(config),
      lock: new DiscordLockfile(resolve(deps.stateDir, `discord-${config.id}.lock`)),
      ...(deps.createDiscordSocket ? { createSocket: deps.createDiscordSocket } : {}),
      ...(deps.discordApiBaseUrl ? { apiBaseUrl: deps.discordApiBaseUrl } : {}),
    });
    return { config, channel };
  }

  /**
   * A unit's Telegram channel persisted something through its sink
   * (pairing claimed an owner, `setEnabled`, …). Fold it into the unit's
   * config entry instead of `config.telegram`.
   */
  private applyChannelPatch(
    id: string,
    patch: { enabled?: boolean; ownerUserId?: number | null },
  ): void {
    const unit = this.units.get(id);
    if (!unit) return;
    const next: SwarmUnitConfig = {
      ...unit.config,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.ownerUserId !== undefined
        ? { ownerUserId: patch.ownerUserId === null ? null : String(patch.ownerUserId) }
        : {}),
    };
    this.units.set(id, { config: next, channel: unit.channel });
    this.persist();
    this.emit();
  }

  private async startUnit(unit: SwarmUnit): Promise<void> {
    try {
      if (unit.channel instanceof DiscordChannel) {
        await unit.channel.setEnabled(true);
      } else {
        await unit.channel.start();
      }
    } catch (err) {
      this.deps.logger.error("swarm: unit start() rejected unexpectedly", {
        id: unit.config.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async stopUnit(unit: SwarmUnit): Promise<void> {
    try {
      await unit.channel.stop();
    } catch (err) {
      this.deps.logger.warn("swarm: unit stop() failed", {
        id: unit.config.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private persist(): void {
    writeSwarmUnits(
      this.paths(),
      [...this.units.values()].map((u) => u.config),
    );
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        this.deps.logger.warn("swarm: change listener threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private require(id: string): SwarmUnit {
    const unit = this.units.get(id);
    if (!unit) throw new Error(`unknown swarm unit '${id}'`);
    return unit;
  }

  private tokenEnvOf(id: string): string {
    return this.units.get(id)?.config.tokenEnv ?? tokenEnvForUnit("telegram", id);
  }

  private pointerPath(config: SwarmUnitConfig): string {
    return resolve(this.deps.stateDir, `${config.kind}-session-${config.id}.json`);
  }

  private paths(): { stateDir: string; userConfigFile: string } {
    return { stateDir: this.deps.stateDir, userConfigFile: this.deps.userConfigFile };
  }
}

function normaliseOwner(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function viewOf(unit: SwarmUnit): SwarmUnitView {
  const { config, channel } = unit;
  const identity = channel.getBotIdentity();
  return {
    id: config.id,
    kind: config.kind,
    label: config.label,
    role: config.role,
    enabled: config.enabled,
    hasToken: readSwarmUnitToken(config.tokenEnv) !== null,
    ownerUserId: config.ownerUserId,
    state: channel.state(),
    lastError: channel.lastError(),
    botUsername: identity?.username ?? null,
    pairing: channel instanceof TelegramChannel ? channel.pairingState() : null,
  };
}
