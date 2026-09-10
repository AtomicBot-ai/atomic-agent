import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
  type DownloadNotifyChannelSetting,
} from "../../config/index.js";

/**
 * Remember where a background download should report when it lands.
 * `null` puts the question back: the next pull asks again.
 */
export function persistDownloadNotifyChannel(
  channel: DownloadNotifyChannelSetting | null,
): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const draft = {
    ...prev,
    notifications: {
      ...prev.notifications,
      downloads: { ...prev.notifications.downloads, channel },
    },
  };
  writeUserConfigFileSync(path, parseUserConfigFile(draft));
  resetConfigCache();
}
