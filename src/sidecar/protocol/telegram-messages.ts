/**
 * Request/response payload shapes for the `telegram.*` commands. See
 * [SIDECAR.md](../../../SIDECAR.md) §4.9. The bot token value never leaves the
 * sidecar; only `hasToken: boolean` is reported.
 */

import type { TelegramStatus } from "../../runtime-api/index.js";

export interface TelegramGetPayload {
  [key: string]: never;
}
export interface TelegramGetResult {
  status: TelegramStatus;
}

export interface TelegramSetEnabledPayload {
  enabled: boolean;
}
export interface TelegramSetEnabledResult {
  status: TelegramStatus;
}

export interface TelegramRestartPayload {
  [key: string]: never;
}
export interface TelegramRestartResult {
  status: TelegramStatus;
}

export interface TelegramSetTokenPayload {
  token: string | null;
}
export interface TelegramSetTokenResult {
  status: TelegramStatus;
}

export interface TelegramSetOwnerPayload {
  ownerUserId: number | null;
}
export interface TelegramSetOwnerResult {
  status: TelegramStatus;
}

export interface TelegramPairPayload {
  timeoutMs?: number;
}
export interface TelegramPairResult {
  started: boolean;
}

export interface TelegramUnpairPayload {
  [key: string]: never;
}
export interface TelegramUnpairResult {
  ok: true;
}
