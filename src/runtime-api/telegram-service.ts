import type { ChannelState } from "../runtime/channel-status.js";

import { RuntimeApiError } from "./runtime-api-error.js";

/**
 * Telegram remote-control surface for the sidecar `telegram.*` handlers.
 * Wraps the live `TelegramChannel` live-control API (`setEnabled`, `restart`,
 * `setToken`, `setOwnerUserId`, `startPairing`, `cancelPairing`) behind the
 * canonical `RuntimeApiError` contract.
 *
 * The bot token value **never** leaves the channel — the facade only ever
 * reports `hasToken: boolean`. When no channel is constructed
 * (`telegramChannel === null`) every op throws `subsystem_disabled`.
 */
export interface TelegramChannelHandle {
  state(): ChannelState;
  lastError(): string | null;
  getOwnerUserId(): number | null;
  getBotIdentity(): { id: number; username: string | null } | null;
  hasToken(): boolean;
  setEnabled(enabled: boolean): Promise<void>;
  restart(): Promise<void>;
  setToken(token: string | null): Promise<void>;
  setOwnerUserId(ownerUserId: number | null): Promise<void>;
  startPairing(timeoutMs?: number): Promise<unknown | null>;
  cancelPairing(): void;
}

export interface TelegramServiceDeps {
  /** Live channel, or `null` when the subsystem is not constructed. */
  channel: TelegramChannelHandle | null;
}

export interface TelegramStatus {
  present: boolean;
  state: ChannelState;
  hasToken: boolean;
  ownerUserId: number | null;
  bot: { id: number; username: string | null } | null;
  lastError: string | null;
}

export function getTelegramStatus(deps: TelegramServiceDeps): TelegramStatus {
  const channel = requireChannel(deps);
  return snapshot(channel);
}

export async function setTelegramEnabled(
  deps: TelegramServiceDeps,
  enabled: boolean,
): Promise<TelegramStatus> {
  if (typeof enabled !== "boolean") {
    throw new RuntimeApiError(
      "enabled must be a boolean",
      "invalid_request",
      "enabled",
    );
  }
  const channel = requireChannel(deps);
  await channel.setEnabled(enabled);
  return snapshot(channel);
}

export async function restartTelegram(
  deps: TelegramServiceDeps,
): Promise<TelegramStatus> {
  const channel = requireChannel(deps);
  await channel.restart();
  return snapshot(channel);
}

export async function setTelegramToken(
  deps: TelegramServiceDeps,
  token: string | null,
): Promise<TelegramStatus> {
  if (token !== null && typeof token !== "string") {
    throw new RuntimeApiError(
      "token must be a string or null",
      "invalid_request",
      "token",
    );
  }
  const channel = requireChannel(deps);
  await channel.setToken(token);
  return snapshot(channel);
}

export async function setTelegramOwner(
  deps: TelegramServiceDeps,
  ownerUserId: number | null,
): Promise<TelegramStatus> {
  if (ownerUserId !== null && typeof ownerUserId !== "number") {
    throw new RuntimeApiError(
      "ownerUserId must be a number or null",
      "invalid_request",
      "ownerUserId",
    );
  }
  const channel = requireChannel(deps);
  await channel.setOwnerUserId(ownerUserId);
  return snapshot(channel);
}

export async function pairTelegram(
  deps: TelegramServiceDeps,
  timeoutMs?: number,
): Promise<{ started: boolean }> {
  const channel = requireChannel(deps);
  const outcome = await channel.startPairing(timeoutMs);
  return { started: outcome !== null };
}

export function unpairTelegram(deps: TelegramServiceDeps): { ok: true } {
  const channel = requireChannel(deps);
  channel.cancelPairing();
  return { ok: true };
}

function requireChannel(deps: TelegramServiceDeps): TelegramChannelHandle {
  if (!deps.channel) {
    throw new RuntimeApiError(
      "telegram channel is not available",
      "subsystem_disabled",
    );
  }
  return deps.channel;
}

function snapshot(channel: TelegramChannelHandle): TelegramStatus {
  return {
    present: true,
    state: channel.state(),
    hasToken: channel.hasToken(),
    ownerUserId: channel.getOwnerUserId(),
    bot: channel.getBotIdentity(),
    lastError: channel.lastError(),
  };
}
