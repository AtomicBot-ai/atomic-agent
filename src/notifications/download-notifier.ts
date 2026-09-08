import { DiscordApi, resolveDiscordToken } from "../channels/discord/index.js";
import {
  TELEGRAM_BOT_TOKEN_KEY,
  scrubErrorMessage,
  sendTelegramOneShot,
} from "../channels/telegram/index.js";
import type { AtomicAgentConfig } from "../config/index.js";
import type { DownloadJob, DownloadNotifyChannel } from "../local-llm/index.js";

/**
 * "Tell me when it lands": the one message a background model download
 * sends when it ends. Runs inside the detached worker, so it must work
 * with no TUI, no channel loop and no bot — a single REST call on the
 * credentials the Integrations hub already stores. Never throws: the
 * download is done either way, and a failed ping is a log line, not an
 * exit code.
 *
 * Plain text on every channel — this is infrastructure speaking, not the
 * agent, the same carve-out the Telegram task reports use.
 */
export type DownloadNotifyResult =
  | { outcome: "sent"; channel: DownloadNotifyChannel }
  | { outcome: "not_configured"; channel: DownloadNotifyChannel; reason: string }
  | { outcome: "failed"; channel: DownloadNotifyChannel; reason: string };

export interface DownloadNotifyInput {
  channel: DownloadNotifyChannel;
  job: DownloadJob;
  config: Pick<AtomicAgentConfig, "telegram" | "discord">;
  /** Defaults to `process.env` — where `loadConfig` puts `<stateDir>/.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /** Test seam for the Telegram endpoint. */
  telegramApiBase?: string;
  /** Test seam for the Discord endpoint. */
  discordApiBase?: string;
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function modelName(job: DownloadJob): string {
  // The label carries the phase — "Qwen 3.5 4B (gguf)" — which is
  // worker detail, not what the operator asked for.
  return job.label.replace(/\s*\((gguf|mmproj)\)\s*$/i, "");
}

/** The message, as it would read on any channel. */
export function formatDownloadNotification(job: DownloadJob): string {
  const name = modelName(job);
  const what = job.phase === "mmproj" ? "Vision projector" : "Model";
  const size = job.totalBytes > 0 ? formatBytes(job.totalBytes) : formatBytes(job.transferredBytes);
  if (job.status === "done") {
    return [
      `✅ ${what} ready: ${name}`,
      `${size} downloaded — open Atomic Agent to use it.`,
    ].join("\n");
  }
  const reason = job.error ?? "unknown error";
  if (job.resumable) {
    const kept =
      job.transferredBytes > 0
        ? `${formatBytes(job.transferredBytes)} of ${size} is kept`
        : "Nothing was downloaded yet";
    return [
      `⏸ Download paused: ${name}`,
      `${reason}.`,
      `${kept} — relaunch Atomic Agent and it resumes by itself.`,
    ].join("\n");
  }
  return [
    `❌ Download failed: ${name}`,
    `${reason}.`,
    `Open Atomic Agent → Models to try again.`,
  ].join("\n");
}

export async function notifyDownloadOutcome(
  input: DownloadNotifyInput,
): Promise<DownloadNotifyResult> {
  const env = input.env ?? process.env;
  const text = formatDownloadNotification(input.job);
  const { channel } = input;
  try {
    if (channel === "telegram") {
      const token = (env[TELEGRAM_BOT_TOKEN_KEY] ?? "").trim();
      const chatId = input.config.telegram.ownerUserId;
      if (!token) return { outcome: "not_configured", channel, reason: "no bot token" };
      if (chatId === null) return { outcome: "not_configured", channel, reason: "not paired" };
      // `sendOutbound` never throws; the reason a chunk was dropped only
      // reaches its logger. Keep the last one so the job log says "401
      // Unauthorized", not just "dropped".
      let lastWarn: string | null = null;
      const result = await sendTelegramOneShot({
        token,
        chatId,
        text,
        logger: {
          warn: (message, context) => {
            const detail = context && typeof context.error === "string" ? context.error : "";
            lastWarn = scrubErrorMessage(detail ? `${message} (${detail})` : message);
          },
        },
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
        ...(input.telegramApiBase ? { apiBase: input.telegramApiBase } : {}),
      });
      return result.dropped > 0
        ? { outcome: "failed", channel, reason: lastWarn ?? `Telegram dropped ${result.dropped} chunk(s)` }
        : { outcome: "sent", channel };
    }
    if (channel === "discord") {
      const token = resolveDiscordToken(undefined, env);
      const userId = input.config.discord.ownerUserId;
      if (!token) return { outcome: "not_configured", channel, reason: "no bot token" };
      if (!userId) return { outcome: "not_configured", channel, reason: "no owner" };
      const api = new DiscordApi({
        token,
        ...(input.discordApiBase ? { baseUrl: input.discordApiBase } : {}),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
      await api.sendMessage(await api.createDmChannel(userId), text);
      return { outcome: "sent", channel };
    }
    // E-mail arrives with the Atomic Mail integration.
    return { outcome: "not_configured", channel, reason: "e-mail notifications are not set up" };
  } catch (err) {
    // Never let a token-bearing URL from an HTTP error reach the job log.
    return { outcome: "failed", channel, reason: scrubErrorMessage(err) };
  }
}

/** True when a ping on `channel` could be delivered right now. */
export function isDownloadNotifyChannelReady(
  channel: DownloadNotifyChannel,
  config: Pick<AtomicAgentConfig, "telegram" | "discord">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (channel === "telegram") {
    return (env[TELEGRAM_BOT_TOKEN_KEY] ?? "").trim().length > 0 && config.telegram.ownerUserId !== null;
  }
  if (channel === "discord") {
    return resolveDiscordToken(undefined, env) !== null && !!config.discord.ownerUserId;
  }
  return false;
}
