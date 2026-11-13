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
import type { OfflineModeControl } from "../runtime-contract.js";

/** The remote-control channels; each talks to the internet on its own. */
interface RemoteChannel {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface OfflineModeDeps {
  /** Write `network.offline` to the user config file. */
  persist?: (enabled: boolean) => void;
  /** Read at call time: the runtime fills these in after construction. */
  channels: () => {
    telegram: RemoteChannel | null;
    discord: RemoteChannel | null;
    swarm: { startEnabled(): Promise<void>; stopAll(): Promise<void> } | null;
  };
  /** Whether the config asks for each channel, read after the write. */
  channelEnabled?: () => { telegram: boolean; discord: boolean };
  warn?: (message: string, error: unknown) => void;
}

/**
 * `runtime.offlineMode` (ATO-1084 / ATO-1087): the live switch the TUI
 * Privacy tab and `/api/offline-mode` drive.
 *
 * `setEnabled` persists `network.offline`, then applies it at once: the
 * HTTP pool and every tool read the flag per request. The Telegram bot
 * (its own HTTP client) and the Discord gateway (a socket opened before
 * the switch) are stopped when it turns on, and started again when it
 * turns off if their config asks for them. With `ATOMIC_AGENT_OFFLINE=1`
 * the process stays offline whatever is set here; `isEnabled` says so.
 */
export function createOfflineModeControl(deps: OfflineModeDeps): OfflineModeControl {
  const persist = deps.persist ?? persistNetworkOffline;
  const channelEnabled = deps.channelEnabled ?? (() => {
    const config = getConfig();
    return { telegram: config.telegram.enabled, discord: config.discord.enabled };
  });
  const warn = deps.warn ?? (() => undefined);
  const settle = async (label: string, work: Promise<void> | undefined) => {
    try {
      await work;
    } catch (err) {
      warn(`offline mode: ${label} failed`, err);
    }
  };
  return {
    isEnabled: () => isOfflineNetwork(),
    egress: () => egressSnapshot(),
    async setEnabled(enabled: boolean): Promise<void> {
      persist(enabled);
      setOfflineNetwork(enabled);
      const { telegram, discord, swarm } = deps.channels();
      if (isOfflineNetwork()) {
        await settle("telegram stop", telegram?.stop());
        await settle("discord stop", discord?.stop());
        await settle("swarm stop", swarm?.stopAll());
        return;
      }
      const wanted = channelEnabled();
      if (wanted.telegram) await settle("telegram start", telegram?.start());
      if (wanted.discord) await settle("discord start", discord?.start());
      await settle("swarm start", swarm?.startEnabled());
    },
  };
}

/** read → merge → validate → write → reset, like the other persist helpers. */
export function persistNetworkOffline(enabled: boolean): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = { ...prev, network: { ...prev.network, offline: enabled } };
  writeUserConfigFileSync(path, parseUserConfigFile(draft));
  resetConfigCache();
}
