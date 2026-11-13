import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../../config/index.js";
import {
  egressSnapshot,
  isOfflineNetwork,
  setOfflineNetwork,
} from "../../llm/offline-network.js";
import type { Channel } from "../../channels/channel.js";
import type { OfflineModeControl } from "../runtime-contract.js";

/** The slice of `ChannelRegistry` offline mode needs. */
interface ChannelList {
  list(): readonly Pick<Channel, "id" | "start" | "stop">[];
}

export interface OfflineModeDeps {
  /** Write `network.offline` to the user config file. */
  persist?: (enabled: boolean) => void;
  /**
   * Read at call time: the runtime fills these in after construction.
   * `registry` is `runtime.channels` (ATO-1169): Telegram, Discord and
   * every catalog adapter. Offline mode walks it rather than naming
   * channels, so a new messenger is covered without touching this file.
   */
  channels: () => {
    registry: ChannelList | null;
    swarm: { startEnabled(): Promise<void>; stopAll(): Promise<void> } | null;
  };
  /** Whether the config asks for channel `id`, read after the write. */
  channelEnabled?: (id: string) => boolean;
  warn?: (message: string, error: unknown) => void;
}

/** `telegram.enabled`, `discord.enabled`, else `channels.<id>.enabled`. */
export function channelEnabledInConfig(id: string): boolean {
  const config = getConfig();
  if (id === "telegram") return config.telegram.enabled;
  if (id === "discord") return config.discord.enabled;
  return config.channels[id]?.enabled ?? false;
}

/**
 * `runtime.offlineMode` (ATO-1084 / ATO-1087): the live switch the TUI
 * Privacy tab and `/api/offline-mode` drive.
 *
 * `setEnabled(true)` applies the switch first and then persists
 * `network.offline`: a failed write rejects with
 * `OfflineModePersistError` while the process stays offline.
 * `setEnabled(false)` persists first and only then goes online. The
 * HTTP pool and every tool read the flag per request. Chat channels keep
 * their own clients and sockets (the Telegram bot, the Discord gateway,
 * Slack, Signal, ...), so every channel in the registry is stopped when
 * it turns on and started again when it turns off if its config asks
 * for it. `ChannelRegistry.startInBackground` refuses to start any of
 * them while offline. With `ATOMIC_AGENT_OFFLINE=1` the process stays
 * offline whatever is set here; `isEnabled` says so.
 */
export function createOfflineModeControl(deps: OfflineModeDeps): OfflineModeControl {
  const persist = deps.persist ?? persistNetworkOffline;
  const channelEnabled = deps.channelEnabled ?? channelEnabledInConfig;
  const warn = deps.warn ?? (() => undefined);
  const settle = async (label: string, work: () => Promise<void> | undefined) => {
    try {
      await work();
    } catch (err) {
      warn(`offline mode: ${label} failed`, err);
    }
  };
  return {
    isEnabled: () => isOfflineNetwork(),
    egress: () => egressSnapshot(),
    async setEnabled(enabled: boolean): Promise<void> {
      const { registry, swarm } = deps.channels();
      const channels = registry?.list() ?? [];
      if (enabled) {
        // Fail closed: the switch and the channel stops come first, so
        // a config that cannot be written (read-only, invalid) still
        // leaves the process offline; the write failure is then
        // reported on its own.
        setOfflineNetwork(true);
        for (const channel of channels) {
          await settle(`${channel.id} stop`, () => channel.stop());
        }
        await settle("swarm stop", () => swarm?.stopAll());
        try {
          persist(true);
        } catch (err) {
          throw new OfflineModePersistError(err);
        }
        return;
      }
      // Turning it off writes first: if the file still says offline,
      // the next start would be offline again, so stay offline now too.
      persist(false);
      setOfflineNetwork(false);
      if (isOfflineNetwork()) return;
      for (const channel of channels) {
        if (channelEnabled(channel.id)) {
          await settle(`${channel.id} start`, () => channel.start());
        }
      }
      await settle("swarm start", () => swarm?.startEnabled());
    },
  };
}

/**
 * Offline mode is on for this process, but `network.offline: true`
 * could not be saved, so the next start will not be offline.
 */
export class OfflineModePersistError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `offline mode is on for this process, but saving network.offline failed: ${detail}`,
      { cause },
    );
    this.name = "OfflineModePersistError";
  }
}

/** read → merge → validate → write → reset, like the other persist helpers. */
export function persistNetworkOffline(enabled: boolean): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = { ...prev, network: { ...prev.network, offline: enabled } };
  writeUserConfigFileSync(path, parseUserConfigFile(draft));
  resetConfigCache();
}
