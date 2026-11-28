/**
 * ATO-2749: the OS pane where the microphone is allowed for this app, for
 * app:openMicSettings (main.ts). macOS: System Settings › Privacy & Security
 * › Microphone. Windows: Settings › Privacy & security › Microphone. Linux
 * has no one place, so there is nothing to open (the page says it in words).
 * No electron here: test/mic-settings.test.mjs reads it.
 */

export function micSettingsUrl(platform: NodeJS.Platform): string | null {
  if (platform === "darwin") return "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
  if (platform === "win32") return "ms-settings:privacy-microphone";
  return null;
}
