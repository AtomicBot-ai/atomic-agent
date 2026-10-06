import { resolve } from "node:path";
import { getUserConfigPath, type AtomicAgentConfig } from "../../config/index.js";
import { TelegramChannel } from "../../channels/telegram/index.js";
import { DiscordChannel } from "../../channels/discord/index.js";
import { DiscordLockfile } from "../../channels/discord/discord-lockfile.js";
import { SwarmRegistry } from "../../channels/swarm/index.js";
import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { ApprovalRouter } from "../../approval/approval-router.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { AgentMetrics } from "../../tracing/agent-metrics.js";
import type { AgentRuntime, CreateAgentRuntimeOptions } from "../runtime-contract.js";

export function connectRuntimeChannels(args: {
  runtime: AgentRuntime & {
    telegramChannel: TelegramChannel | null;
    discordChannel: DiscordChannel | null;
    swarm: SwarmRegistry | null;
  };
  config: AtomicAgentConfig;
  logger: StructuredLogger;
  metrics: AgentMetrics;
  approvals: ApprovalGate;
  approvalRouter: ApprovalRouter;
  options: Pick<CreateAgentRuntimeOptions, "handlers" | "overrides">;
  connectTelegram: (channel: TelegramChannel) => void;
  connectDiscord: (channel: DiscordChannel) => void;
  connectSwarm: (swarm: SwarmRegistry) => void;
}): void {
  const { runtime, config, logger, metrics, approvals, approvalRouter, options, connectTelegram, connectDiscord, connectSwarm } = args;
  // Telegram remote-control channel. The channel is always constructed
  // (even when `telegram.enabled === false` at boot) so slice-3B
  // live-control surfaces can flip it on without restarting the host —
  // the constructor is side-effect-free, only `start()` opens the
  // network connection. The channel owns token resolution end-to-end
  // (reads `TELEGRAM_BOT_TOKEN` from the env on construction);
  // bootstrap deliberately does not look at the env var so it stays
  // agnostic of telegram-specific naming. `start()` is fired-and-
  // forgotten so a slow `getMe` probe never delays the first user
  // turn; when `enabled=true` but no token is present, the channel
  // transitions to `down` with `lastError: "missing
  // TELEGRAM_BOT_TOKEN"`.
  const telegramChannel = new TelegramChannel({
    runtime,
    config,
    logger,
    metrics,
    emitStatus: (status) => options.handlers?.onChannelStatus?.(status),
    ...(options.overrides?.telegramBotFactory
      ? { botFactory: options.overrides.telegramBotFactory }
      : {}),
  });
  runtime.telegramChannel = telegramChannel;
  connectTelegram(telegramChannel);
  if (config.telegram.enabled) {
    void telegramChannel.start().catch((err) => {
      logger.error("telegram: start() rejected unexpectedly", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Discord: same shape as Telegram — constructed unconditionally so
  // the Integrations hub can report its state, started only when the
  // operator enabled it. `start()` is fire-and-forget so a slow
  // `/users/@me` probe never delays the first turn, and a missing
  // token settles as `disabled` rather than `down` (an unconfigured
  // integration is a resting state, not a failure).
  const discordChannel = new DiscordChannel({
    runtime,
    logger,
    approvals,
    approvalRouter,
    enabled: config.discord.enabled,
    ownerUserIds: config.discord.ownerUserIds,
    sessionPointerPath: resolve(config.paths.stateDir, "discord-session.json"),
    inboxDir: resolve(config.paths.stateDir, "inbox", "discord"),
    lock: new DiscordLockfile(resolve(config.paths.stateDir, "discord.lock")),
    onStatus: (status) => options.handlers?.onChannelStatus?.(status),
  });
  runtime.discordChannel = discordChannel;
  connectDiscord(discordChannel);
  if (config.discord.enabled) {
    void discordChannel.start().catch((err) => {
      logger.error("discord: start() rejected unexpectedly", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Swarm: extra bots beside the two primaries. Constructed
  // unconditionally so the Swarm tab can list them; each enabled unit
  // with a token is started fire-and-forget, like the primaries.
  const swarm = new SwarmRegistry({
    runtime,
    config,
    logger,
    approvals,
    approvalRouter,
    stateDir: config.paths.stateDir,
    userConfigFile: getUserConfigPath(config.paths.stateDir),
    ...(options.overrides?.telegramBotFactory
      ? { telegramBotFactory: options.overrides.telegramBotFactory }
      : {}),
  });
  runtime.swarm = swarm;
  connectSwarm(swarm);
  void swarm.startEnabled();
}
