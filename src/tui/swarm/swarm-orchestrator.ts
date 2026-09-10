import type { SwarmUnitView } from "../../channels/swarm/index.js";
import { getConfig } from "../../config/index.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { TuiEventBus } from "../tui-app.js";
import type { SwarmEditField, SwarmKind, SwarmRow } from "./swarm-panel-state.js";

/** Countdown refresh while a Telegram pairing window is open. */
const PAIRING_TICK_MS = 1_000;

export interface SwarmAddInput {
  kind: SwarmKind;
  label: string;
  role: string;
  token: string;
  ownerUserId: string;
}

/**
 * The only TUI module that drives `runtime.swarm` on behalf of the Swarm
 * tab. The reducer and component stay pure; every side effect — adding
 * a bot (config + `.env` + channel start), edits, pairing, removal — is
 * funnelled through here, mirroring the other TUI orchestrators.
 *
 * The two primary channels are listed for the full picture but stay
 * read-only here: their owner is the Integrations hub, and a second
 * writer for the same settings would drift.
 */
export class SwarmOrchestrator {
  private unsubscribe: (() => void) | null = null;
  private pairingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
    private readonly now: () => number = () => Date.now(),
  ) {
    this.unsubscribe = runtime.swarm?.onChange(() => this.refresh()) ?? null;
  }

  /** Rebuild every row from config + live channel state. */
  refresh(): void {
    const rows = this.buildRows();
    this.bus.emit({ type: "swarm_synced", rows });
    this.syncPairingTicker(rows);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopPairingTicker();
  }

  async add(input: SwarmAddInput): Promise<void> {
    const swarm = this.runtime.swarm;
    if (!swarm) {
      this.settle(undefined, "the swarm registry is not available in this build");
      return;
    }
    if (input.label.trim().length === 0) {
      this.settle(undefined, "a bot needs a label");
      return;
    }
    const owner = input.ownerUserId.trim();
    if (owner.length > 0 && !/^\d{1,25}$/.test(owner)) {
      this.settle(undefined, "owner id must be numeric (Telegram user id / Discord snowflake)");
      return;
    }
    this.bus.emit({ type: "swarm_action_started" });
    try {
      const unit = await swarm.add({
        kind: input.kind,
        label: input.label,
        role: input.role,
        token: input.token.trim().length > 0 ? input.token.trim() : null,
        ownerUserId: owner.length > 0 ? owner : null,
      });
      const hasToken = input.token.trim().length > 0;
      const tail = !hasToken
        ? " — set its token with e"
        : input.kind === "telegram" && owner.length === 0
          ? " — press p to pair by DM"
          : owner.length === 0
            ? " — set the owner id with e"
            : "";
      this.settle(`${unit.config.label} added${tail}`);
    } catch (err) {
      this.settle(undefined, describe(err));
    }
    this.refresh();
  }

  async saveField(id: string, field: SwarmEditField, value: string): Promise<void> {
    const swarm = this.runtime.swarm;
    if (!swarm || isPrimary(id)) {
      this.settle(undefined, "the primary bots are edited in /integrations");
      return;
    }
    this.bus.emit({ type: "swarm_action_started" });
    try {
      switch (field) {
        case "label":
          await swarm.update(id, { label: value });
          break;
        case "role":
          await swarm.update(id, { role: value });
          break;
        case "owner": {
          const trimmed = value.trim();
          if (trimmed.length > 0 && !/^\d{1,25}$/.test(trimmed)) {
            throw new Error("owner id must be numeric");
          }
          await swarm.update(id, { ownerUserId: trimmed.length > 0 ? trimmed : null });
          break;
        }
        case "token":
          await swarm.setToken(id, value.trim().length > 0 ? value.trim() : null);
          break;
      }
      this.settle(`${field} saved`);
    } catch (err) {
      this.settle(undefined, describe(err));
    }
    this.refresh();
  }

  async toggle(id: string): Promise<void> {
    const swarm = this.runtime.swarm;
    if (!swarm || isPrimary(id)) {
      this.settle(undefined, "switch the primary bots on/off in /integrations");
      return;
    }
    const unit = swarm.get(id);
    if (!unit) return;
    this.bus.emit({ type: "swarm_action_started" });
    try {
      const enabled = !unit.config.enabled;
      await swarm.update(id, { enabled });
      this.settle(`${unit.config.label} ${enabled ? "on" : "off"}`);
    } catch (err) {
      this.settle(undefined, describe(err));
    }
    this.refresh();
  }

  async remove(id: string): Promise<void> {
    const swarm = this.runtime.swarm;
    if (!swarm || isPrimary(id)) {
      this.settle(undefined, "the primary bots are managed in /integrations and cannot be removed");
      return;
    }
    const label = swarm.get(id)?.config.label ?? id;
    this.bus.emit({ type: "swarm_action_started" });
    try {
      await swarm.remove(id);
      this.settle(`${label} removed`);
    } catch (err) {
      this.settle(undefined, describe(err));
    }
    this.refresh();
  }

  async pair(id: string): Promise<void> {
    const swarm = this.runtime.swarm;
    if (!swarm || isPrimary(id)) {
      this.settle(undefined, "pair the primary Telegram bot in /integrations");
      return;
    }
    const unit = swarm.get(id);
    if (!unit) return;
    if (unit.config.kind !== "telegram") {
      this.settle(undefined, "Discord bots do not pair — set the owner id with e");
      return;
    }
    // Pairing needs a running bot. Starting one the operator switched
    // off, silently, would leave the row saying "off" while the bot is
    // live — say what is missing instead.
    if (!unit.config.enabled) {
      this.settle(undefined, `${unit.config.label} is off — press enter to switch it on first`);
      return;
    }
    this.bus.emit({ type: "swarm_action_started" });
    try {
      // Returns once the window closes: claimed, timed out, or cancelled.
      this.settle(`pairing ${unit.config.label} — DM the bot within 60s`);
      this.refresh();
      const outcome = await swarm.startPairing(id);
      this.settle(
        outcome
          ? `${unit.config.label} paired with user ${outcome.claim.userId}`
          : `${unit.config.label}: pairing window closed without a claim`,
      );
    } catch (err) {
      this.settle(undefined, describe(err));
    }
    this.refresh();
  }

  async restart(id: string): Promise<void> {
    const swarm = this.runtime.swarm;
    if (!swarm || isPrimary(id)) {
      this.settle(undefined, "restart the primary bots in /integrations");
      return;
    }
    this.bus.emit({ type: "swarm_action_started" });
    try {
      await swarm.restart(id);
      this.settle("restarted");
    } catch (err) {
      this.settle(undefined, describe(err));
    }
    this.refresh();
  }

  // ---------------------------------------------------------------------

  private buildRows(): SwarmRow[] {
    const config = getConfig();
    const rows: SwarmRow[] = [];
    const telegram = this.runtime.telegramChannel;
    if (telegram) {
      const identity = telegram.getBotIdentity();
      const pairing = telegram.pairingState();
      rows.push({
        id: "primary:telegram",
        kind: "telegram",
        primary: true,
        label: "Telegram",
        role: "primary",
        enabled: config.telegram.enabled,
        hasToken: telegram.hasToken(),
        ownerUserId: config.telegram.ownerUserId === null ? null : String(config.telegram.ownerUserId),
        state: telegram.state(),
        lastError: telegram.lastError(),
        botUsername: identity?.username ?? null,
        pairing: pairing.active
          ? { active: true, secondsLeft: secondsLeft(pairing.expiresAt, this.now()) }
          : null,
      });
    }
    const discord = this.runtime.discordChannel;
    if (discord) {
      const identity = discord.getBotIdentity();
      rows.push({
        id: "primary:discord",
        kind: "discord",
        primary: true,
        label: "Discord",
        role: "primary",
        enabled: config.discord.enabled,
        hasToken: discord.hasToken(),
        ownerUserId: config.discord.ownerUserId,
        state: discord.state(),
        lastError: discord.lastError(),
        botUsername: identity?.username ?? null,
        pairing: null,
      });
    }
    for (const view of this.runtime.swarm?.views() ?? []) rows.push(rowOf(view, this.now()));
    return rows;
  }

  private settle(message?: string, error?: string): void {
    this.bus.emit({
      type: "swarm_action_settled",
      ...(message === undefined ? {} : { message }),
      ...(error === undefined ? {} : { error }),
    });
  }

  private syncPairingTicker(rows: readonly SwarmRow[]): void {
    const active = rows.some((r) => r.pairing?.active === true);
    if (active && this.pairingTimer === null) {
      this.pairingTimer = setInterval(() => this.refresh(), PAIRING_TICK_MS);
    } else if (!active) {
      this.stopPairingTicker();
    }
  }

  private stopPairingTicker(): void {
    if (this.pairingTimer !== null) {
      clearInterval(this.pairingTimer);
      this.pairingTimer = null;
    }
  }
}

function isPrimary(id: string): boolean {
  return id.startsWith("primary:");
}

function rowOf(view: SwarmUnitView, now: number): SwarmRow {
  return {
    id: view.id,
    kind: view.kind,
    primary: false,
    label: view.label,
    role: view.role,
    enabled: view.enabled,
    hasToken: view.hasToken,
    ownerUserId: view.ownerUserId,
    state: view.state,
    lastError: view.lastError,
    botUsername: view.botUsername,
    pairing:
      view.pairing?.active === true
        ? { active: true, secondsLeft: secondsLeft(view.pairing.expiresAt, now) }
        : null,
  };
}

function secondsLeft(expiresAt: number | null, now: number): number | null {
  if (expiresAt === null) return null;
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
