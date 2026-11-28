/**
 * ATO-2499 "Show once" on Windows and Linux: whether this computer can
 * record, and the plain words when it cannot. Pure, no electron import.
 *
 *   macOS   the Accessibility helper or osascript (needs Accessibility)
 *   Windows uiohook-napi plus one resident PowerShell that names the window
 *           in front and the UI Automation control under a click
 *           (show-once-win.ts); nothing to allow
 *   Linux   uiohook-napi on X11 plus `xdotool` for the window in front
 *           (show-once-linux.ts). Wayland does not let one app watch the
 *           clicks and keys of others, so a Wayland session gets a hint
 *           instead of the Record button; so does a desktop without xdotool.
 */

export type ShowOnceSupport =
  | { ok: true }
  | { ok: false; reason: "platform" | "wayland" | "no-display" | "no-xdotool"; message: string };

export const SHOW_ONCE_WAYLAND =
  "Show once needs an X11 session on Linux: Wayland does not let one app watch clicks and keys in other apps. "
  + "Sign out and choose your desktop's X11 or Xorg session at the login screen to use it.";
export const SHOW_ONCE_NO_XDOTOOL =
  "Show once on Linux needs xdotool to know which window is in front. Install it (sudo apt install xdotool, or sudo dnf install xdotool), then click Record again.";

export function showOnceSupport(
  platform: NodeJS.Platform | string,
  env: Record<string, string | undefined>,
  hasXdotool: () => boolean,
): ShowOnceSupport {
  if (platform === "darwin" || platform === "win32") return { ok: true };
  if (platform !== "linux") return { ok: false, reason: "platform", message: "Show once does not record on this system." };
  if (String(env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland" || env.WAYLAND_DISPLAY) {
    return { ok: false, reason: "wayland", message: SHOW_ONCE_WAYLAND };
  }
  if (!env.DISPLAY) return { ok: false, reason: "no-display", message: "Show once needs a desktop session with a display; none was found." };
  if (!hasXdotool()) return { ok: false, reason: "no-xdotool", message: SHOW_ONCE_NO_XDOTOOL };
  return { ok: true };
}

/** How the skill and the card name this computer. */
export function showOnceOsName(platform: NodeJS.Platform | string): string {
  return platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : "macOS";
}

export type ShowOnceGate = { ok: true } | { ok: false; reason: string; error: string; permission?: true };

/**
 * Whether Record may start now (show-once-ipc.ts start). `axTrusted` is
 * macOS's Accessibility check (asked with `prompt` true, macOS shows its own
 * prompt); Windows asks for nothing.
 */
export function showOnceGate(o: {
  platform: NodeJS.Platform | string;
  remote: boolean;
  support: ShowOnceSupport;
  axTrusted: (prompt: boolean) => boolean;
}): ShowOnceGate {
  if (!o.support.ok) return { ok: false, reason: o.support.reason, error: o.support.message };
  if (o.remote) return { ok: false, reason: "remote", error: "Show once records on the computer that runs the agent." };
  if (o.platform === "darwin" && !o.axTrusted(false)) {
    o.axTrusted(true);
    return { ok: false, reason: "permission", permission: true, error: "Allow Atomic Agent in System Settings › Privacy & Security › Accessibility, then click Record again." };
  }
  return { ok: true };
}
