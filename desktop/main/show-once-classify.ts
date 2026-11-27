import type { ShowOnceApp, ShowOnceElement } from "./show-once-log.js";

/**
 * ATO-2401 / ATO-2499 "Show once": which app an event happened in (Atomic
 * Agent itself, a protected app, a browser, any other app), what one key
 * is (typing, a chord, nothing), and which control labels may be kept.
 * Pure, no electron import; split out of show-once-log.ts, which folds the
 * events into steps with these rules.
 */

/** Characters of a control label or a window title kept. */
export const SHOW_ONCE_MAX_LABEL = 60;

/** No input of any kind recorded (src/tools/os/screen/screen-protected.ts BLOCKED_BUNDLE_IDS). */
export const SHOW_ONCE_PROTECTED_BUNDLE_IDS: readonly string[] = [
  "io.atomicagent.desktop",
  "com.apple.systempreferences",
  "com.apple.Settings",
  "com.apple.keychainaccess",
  "com.apple.SecurityAgent",
  "com.apple.loginwindow",
  "com.apple.Passwords",
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.bitwarden.desktop",
  "com.apple.ScriptEditor2",
  "com.apple.Automator",
  "com.apple.shortcuts",
  "org.hammerspoon.Hammerspoon",
  "com.stairways.keyboardmaestro",
  "com.runningwithcrayons.Alfred",
  "com.runningwithcrayons.Alfred-Preferences",
  "com.raycast.macos",
  "at.obdev.LaunchBar",
];

/** Password managers the id list may not name, matched on the app's name. */
const PROTECTED_NAME_RE = /password|1password|bitwarden|keychain|lastpass|dashlane|keepass|enpass|proton pass|authenticator/i;

/** Browsers: steps are kept, control labels are not (the page wrote them). */
const BROWSER_BUNDLE_PREFIXES: readonly string[] = [
  "com.apple.safari", "com.google.chrome", "org.chromium.chromium", "company.thebrowser", "com.microsoft.edgemac",
  "org.mozilla.", "com.brave.browser", "com.operasoftware.", "com.vivaldi.vivaldi", "com.kagi.kagimacos",
  "com.duckduckgo.macos.browser", "app.zen-browser.zen", "org.torproject.torbrowser", "ru.yandex.desktop.yandex-browser",
  "ai.perplexity.comet", "com.openai.atlas",
];

/**
 * ATO-2499 Windows and Linux: there an app is named by its executable
 * (show-once-win.ts `notepad.exe`, show-once-linux.ts `gedit`), lowercased,
 * so these lists match it exactly. Settings, sign-in and password prompts,
 * keyrings and automation tools record nothing, as on the Mac.
 */
const DESKTOP_PROTECTED_EXES: ReadonlySet<string> = new Set([
  "atomic agent.exe", "atomic-agent-desktop",
  "systemsettings.exe", "consent.exe", "logonui.exe", "lockapp.exe", "credentialuibroker.exe", "credwiz.exe",
  "keepass.exe", "keepassxc.exe", "1password.exe", "bitwarden.exe", "autohotkey.exe", "autohotkey64.exe", "autohotkeyu64.exe",
  "gnome-control-center", "systemsettings", "systemsettings5", "seahorse", "keepassxc", "kwalletmanager5", "kwalletmanager",
  "gcr-prompter", "gcr4-ssh-askpass", "pinentry", "pinentry-gnome3", "pinentry-qt", "polkit-gnome-authentication-agent-1",
  "polkit-kde-authentication-agent-1", "lxqt-policykit-agent", "1password", "bitwarden", "xdotool", "autokey-gtk", "autokey-qt",
]);

const DESKTOP_BROWSER_EXES: ReadonlySet<string> = new Set([
  "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe", "arc.exe", "zen.exe", "librewolf.exe",
  "waterfox.exe", "browser.exe", "comet.exe", "iexplore.exe", "chromium.exe",
  "chrome", "google-chrome", "chromium", "chromium-browser", "firefox", "firefox-bin", "firefox-esr", "brave", "brave-browser",
  "opera", "vivaldi-bin", "msedge", "microsoft-edge", "zen", "zen-bin", "librewolf", "epiphany", "falkon", "yandex_browser",
]);

export type ShowOnceAppClass = "own" | "protected" | "browser" | "open" | "unknown";

function idMatches(list: readonly string[], lower: string): boolean {
  return list.some((id) => {
    const e = id.toLowerCase();
    return lower === e || lower.startsWith(`${e}.`);
  });
}

export function showOnceAppClass(app: ShowOnceApp | null, ownPid: number): ShowOnceAppClass {
  if (!app) return "unknown";
  if (app.pid !== null && app.pid === ownPid) return "own";
  if (!app.bundleId) return "unknown";
  const lower = app.bundleId.toLowerCase();
  if (lower === "io.atomicagent.desktop" || lower === "atomic agent.exe" || lower === "atomic-agent-desktop") return "own";
  // A UWP window (Settings, Windows Security) whose real app show-once-win.ts could not reach: not named, not recorded.
  if (lower === "applicationframehost.exe") return "unknown";
  if (DESKTOP_PROTECTED_EXES.has(lower)) return "protected";
  if (DESKTOP_BROWSER_EXES.has(lower)) return "browser";
  if (idMatches(SHOW_ONCE_PROTECTED_BUNDLE_IDS, lower) || PROTECTED_NAME_RE.test(app.name || "")) return "protected";
  if (BROWSER_BUNDLE_PREFIXES.some((p) => lower.startsWith(p))) return "browser";
  return "open";
}

/** uiohook-napi key codes (libuiohook VC_*) that are modifiers alone. */
const MODIFIER_CODES = new Set([42, 54, 29, 3613, 56, 3640, 3675, 3676, 58]);

/** Keys that type a character (or erase one): their runs become one "text" step. */
const TEXT_KEYS: Readonly<Record<number, string>> = {
  16: "q", 17: "w", 18: "e", 19: "r", 20: "t", 21: "y", 22: "u", 23: "i", 24: "o", 25: "p",
  30: "a", 31: "s", 32: "d", 33: "f", 34: "g", 35: "h", 36: "j", 37: "k", 38: "l",
  44: "z", 45: "x", 46: "c", 47: "v", 48: "b", 49: "n", 50: "m",
  2: "1", 3: "2", 4: "3", 5: "4", 6: "5", 7: "6", 8: "7", 9: "8", 10: "9", 11: "0",
  12: "-", 13: "=", 26: "[", 27: "]", 39: ";", 40: "'", 41: "`", 43: "\\", 51: ",", 52: ".", 53: "/",
  57: "space", 14: "backspace",
};

/** Keys that act rather than type, named the way os.screen.key reads them (src/tools/os/screen/screen-keys.ts). */
const ACTION_KEYS: Readonly<Record<number, string>> = {
  1: "escape", 15: "tab", 28: "return", 3612: "return",
  59: "f1", 60: "f2", 61: "f3", 62: "f4", 63: "f5", 64: "f6", 65: "f7", 66: "f8", 67: "f9", 68: "f10", 87: "f11", 88: "f12",
  3655: "home", 3663: "end", 3657: "pageup", 3665: "pagedown", 3667: "forwarddelete",
  57416: "up", 57424: "down", 57419: "left", 57421: "right",
};

export type KeyKind = { kind: "ignore" } | { kind: "text" } | { kind: "keys"; keys: string };

/**
 * What one keydown is: nothing (a modifier alone), typing, or a chord to keep.
 * ATO-2499 `platform`: off the Mac the meta key is the Windows (Super) key,
 * whose chords belong to the desktop (Win+R, Win+D), so they are left out,
 * as are Alt+Tab, Alt+Esc, Ctrl+Esc and Ctrl+Alt+Delete. AltGr reaches the
 * Windows hook as Ctrl+Alt, so Ctrl+Alt on a typing key (`@` is AltGr+Q on a
 * German layout) is typing there, never a chord that would name the character.
 */
export function classifyKey(e: { keycode: number; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }, platform: string = "darwin"): KeyKind {
  if (MODIFIER_CODES.has(e.keycode)) return { kind: "ignore" };
  const text = TEXT_KEYS[e.keycode];
  const action = ACTION_KEYS[e.keycode];
  if (platform !== "darwin" && (e.meta || (e.alt && (e.keycode === 15 || e.keycode === 1)) || (e.ctrl && e.keycode === 1)
    || (e.ctrl && e.alt && (e.keycode === 3667 || e.keycode === 83)))) {
    return { kind: "ignore" };
  }
  if (platform !== "darwin" && e.ctrl && e.alt && text !== undefined) return { kind: "text" };
  const mods = [e.ctrl ? "ctrl" : "", e.alt ? "alt" : "", e.shift ? "shift" : "", e.meta ? "cmd" : ""].filter(Boolean);
  // App and space switching, Spotlight and launchers, Force Quit: the agent's screen guard refuses
  // these chords (refusedChordReason in screen-protected.ts), so a replay could not press them anyway.
  if ((e.meta && (e.keycode === 15 || e.keycode === 41 || e.keycode === 57)) || ((e.ctrl || e.alt) && e.keycode === 57)
    || (e.ctrl && action !== undefined && ["up", "down", "left", "right"].includes(action)) || (e.meta && e.alt && e.keycode === 1)) {
    return { kind: "ignore" };
  }
  if (e.meta || e.ctrl) {
    const key = text ?? action;
    // A chord on a key this table does not know is left out rather than guessed.
    return key ? { kind: "keys", keys: [...mods, key].join("+") } : { kind: "ignore" };
  }
  if (action) return { kind: "keys", keys: [...mods, action].join("+") };
  if (text) return { kind: "text" };
  return { kind: "ignore" };
}

/** Control roles whose label names the control (a button's title), not the person's content. */
const LABELLED_ROLES = new Set([
  "AXButton", "AXMenuItem", "AXMenuBarItem", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton",
  "AXTab", "AXTextField", "AXSearchField", "AXComboBox", "AXDisclosureTriangle", "AXSlider", "AXIncrementor",
]);

/** A label safe to write into a skill: a control's own name, one line, short, no markup. */
export function cleanLabel(raw: string): string {
  const s = String(raw || "").replace(/[\u0000-\u001f\u007f`*_#<>|[\]]/g, " ").replace(/"/g, "'").replace(/\s+/g, " ").trim();
  return s.length > SHOW_ONCE_MAX_LABEL ? `${s.slice(0, SHOW_ONCE_MAX_LABEL - 1).trimEnd()}…` : s;
}

export function keptElement(el: ShowOnceElement | null | undefined, browser: boolean): ShowOnceElement | null {
  if (!el || typeof el.role !== "string" || !/^AX[A-Za-z]{1,40}$/.test(el.role)) return null;
  if (el.role === "AXSecureTextField") return { role: el.role, label: "" };
  const label = !browser && LABELLED_ROLES.has(el.role) ? cleanLabel(el.label) : "";
  return { role: el.role, label };
}

