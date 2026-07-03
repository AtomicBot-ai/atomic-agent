import {
  getTelegramStatus,
  pairTelegram,
  restartTelegram,
  setTelegramEnabled,
  setTelegramOwner,
  setTelegramToken,
  unpairTelegram,
  type TelegramServiceDeps,
} from "../../runtime-api/index.js";
import type {
  TelegramGetPayload,
  TelegramGetResult,
  TelegramPairPayload,
  TelegramPairResult,
  TelegramRestartPayload,
  TelegramRestartResult,
  TelegramSetEnabledPayload,
  TelegramSetEnabledResult,
  TelegramSetOwnerPayload,
  TelegramSetOwnerResult,
  TelegramSetTokenPayload,
  TelegramSetTokenResult,
  TelegramUnpairPayload,
  TelegramUnpairResult,
} from "../protocol/index.js";
import type { SidecarHandlerContext } from "./handler-context.js";

/**
 * `telegram.*` — remote-control of the Telegram channel. Every mutation goes
 * through the live `TelegramChannel` live-control API; the channel emits its
 * own `channel.status` lifecycle events, so no extra event is emitted here.
 * The bot token value never leaves the sidecar — only `hasToken` is reported.
 * When no channel is constructed, every op resolves with
 * `error.code = "subsystem_disabled"`.
 */
export function registerTelegramHandlers(ctx: SidecarHandlerContext): void {
  const { router, runtime } = ctx;

  const deps: TelegramServiceDeps = {
    channel: runtime.telegramChannel,
  };

  router.register<TelegramGetPayload, TelegramGetResult>(
    "telegram.get",
    () => ({ status: getTelegramStatus(deps) }),
  );

  router.register<TelegramSetEnabledPayload, TelegramSetEnabledResult>(
    "telegram.setEnabled",
    async (request) => ({
      status: await setTelegramEnabled(deps, request.payload.enabled),
    }),
  );

  router.register<TelegramRestartPayload, TelegramRestartResult>(
    "telegram.restart",
    async () => ({ status: await restartTelegram(deps) }),
  );

  router.register<TelegramSetTokenPayload, TelegramSetTokenResult>(
    "telegram.setToken",
    async (request) => ({
      status: await setTelegramToken(deps, request.payload.token),
    }),
  );

  router.register<TelegramSetOwnerPayload, TelegramSetOwnerResult>(
    "telegram.setOwner",
    async (request) => ({
      status: await setTelegramOwner(deps, request.payload.ownerUserId),
    }),
  );

  router.register<TelegramPairPayload, TelegramPairResult>(
    "telegram.pair",
    (request) => pairTelegram(deps, request.payload.timeoutMs),
  );

  router.register<TelegramUnpairPayload, TelegramUnpairResult>(
    "telegram.unpair",
    () => unpairTelegram(deps),
  );
}
