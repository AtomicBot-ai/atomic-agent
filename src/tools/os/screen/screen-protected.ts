import type { KeyChord } from "./screen-keys.js";

/**
 * What screen control may do in an app, decided from the bundle id of the
 * app that would receive the input, on every call (the click point's
 * window owner, otherwise the frontmost app) and pinned for the action
 * itself (`screen-jxa.ts` refuses if a different app is there by then).
 * The same split Claude's own computer use makes:
 *
 * - `blocked`: no input at all. Atomic Agent itself and the app that
 *   launched the agent (its TUI takes mouse input and slash commands, so
 *   a click or "/mode bypass" + return there would raise its approval
 *   level), settings, credentials, the login and security prompts, and
 *   script runners that post input of their own.
 * - `browser`: read-only. Screenshots are fine; clicks, typing and keys
 *   are refused, because a web page is where a password, a payment or a
 *   submit happens, and the browser tool asks for those
 *   (`browser_secret`, `browser_commit`) where screen control cannot.
 * - `terminal`: terminals and IDEs. Clicks are allowed (focus, a tab, a
 *   button); typing and keys are refused, because a keystroke there runs
 *   a command and the agent has `os.shell.run` for that, with its own
 *   approval.
 * - `open`: anything else, behind the `screen_control` approval.
 *
 * An unidentified target (no bundle id) is refused: the guard cannot vouch
 * for an app it cannot name. Matching is case-insensitive; an id also
 * covers its sub-ids (`com.google.Chrome.app.<id>` web apps,
 * `com.apple.Safari.WebApp.<id>`, `com.jetbrains.<ide>`).
 */
export type ScreenAppClass = "blocked" | "browser" | "terminal" | "open";
export type ScreenInputKind = "click" | "type" | "key";

/** No input of any kind (plus the host app, see `hostBundleIds`). */
export const BLOCKED_BUNDLE_IDS: readonly string[] = [
  // Atomic Agent itself.
  "io.atomicagent.desktop",
  // Permissions, credentials, the login and security prompts.
  "com.apple.systempreferences",
  "com.apple.Settings",
  "com.apple.keychainaccess",
  "com.apple.SecurityAgent",
  "com.apple.loginwindow",
  "com.apple.Passwords",
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.bitwarden.desktop",
  // Apps that run scripts which post input themselves.
  "com.apple.ScriptEditor2",
  "com.apple.Automator",
  "com.apple.shortcuts",
];

/** Web browsers: screenshots only. */
export const BROWSER_BUNDLE_IDS: readonly string[] = [
  "com.apple.Safari",
  "com.apple.SafariTechnologyPreview",
  "com.google.Chrome",
  "com.google.Chrome.beta",
  "com.google.Chrome.dev",
  "com.google.Chrome.canary",
  "org.chromium.Chromium",
  "company.thebrowser.Browser", // Arc
  "company.thebrowser.dia",
  "com.microsoft.edgemac",
  "com.microsoft.edgemac.Beta",
  "com.microsoft.edgemac.Dev",
  "com.microsoft.edgemac.Canary",
  "org.mozilla.firefox",
  "org.mozilla.firefoxdeveloperedition",
  "org.mozilla.nightly",
  "com.brave.Browser",
  "com.brave.Browser.beta",
  "com.brave.Browser.nightly",
  "com.operasoftware.Opera",
  "com.operasoftware.OperaGX",
  "com.operasoftware.OperaAir",
  "com.vivaldi.Vivaldi",
  "com.kagi.kagimacOS", // Orion
  "com.duckduckgo.macos.browser",
  "app.zen-browser.zen",
  "org.torproject.torbrowser",
  "ru.yandex.desktop.yandex-browser",
  "com.naver.Whale",
];

/** Terminals and IDEs: clicks only. */
export const TERMINAL_BUNDLE_IDS: readonly string[] = [
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "dev.warp.Warp-Stable",
  "dev.warp.Warp",
  "com.mitchellh.ghostty",
  "net.kovidgoyal.kitty",
  "org.alacritty",
  "com.github.wez.wezterm",
  "co.zeit.hyper",
  "com.microsoft.VSCode",
  "com.microsoft.VSCodeInsiders",
  "com.vscodium",
  "com.todesktop.230313mzl4w4u92", // Cursor
  "com.exafunction.windsurf",
  "dev.zed.Zed",
  "dev.zed.Zed-Preview",
  "com.jetbrains", // every JetBrains IDE: com.jetbrains.intellij, .pycharm, .WebStorm, …
  "com.google.android.studio",
  "com.apple.dt.Xcode",
  "com.sublimetext.4",
  "com.panic.Nova",
];

/** `TERM_PROGRAM` values → the bundle id of the terminal that set them. */
const TERM_PROGRAM_BUNDLES: Readonly<Record<string, string>> = {
  Apple_Terminal: "com.apple.Terminal",
  "iTerm.app": "com.googlecode.iterm2",
  vscode: "com.microsoft.VSCode",
  WarpTerminal: "dev.warp.Warp-Stable",
  ghostty: "com.mitchellh.ghostty",
  WezTerm: "com.github.wez.wezterm",
};

/** The app that launched the agent, as far as its environment says. */
export function hostBundleIds(env: NodeJS.ProcessEnv): string[] {
  const ids: string[] = [];
  const bundle = env.__CFBundleIdentifier;
  if (bundle) ids.push(bundle);
  const term = env.TERM_PROGRAM ? TERM_PROGRAM_BUNDLES[env.TERM_PROGRAM] : undefined;
  if (term) ids.push(term);
  return ids;
}

function matches(list: readonly string[], lower: string): boolean {
  return list.some((id) => {
    const entry = id.toLowerCase();
    return lower === entry || lower.startsWith(`${entry}.`);
  });
}

/** The class of the app with this bundle id; `null` when there is no id to judge. */
export function screenAppClass(bundleId: string | null | undefined, env: NodeJS.ProcessEnv): ScreenAppClass | null {
  if (!bundleId) return null;
  const lower = bundleId.toLowerCase();
  if (matches(BLOCKED_BUNDLE_IDS, lower) || hostBundleIds(env).some((id) => id.toLowerCase() === lower)) return "blocked";
  if (matches(BROWSER_BUNDLE_IDS, lower)) return "browser";
  if (matches(TERMINAL_BUNDLE_IDS, lower)) return "terminal";
  return "open";
}

/**
 * Exact ids the action script itself refuses for this kind of input —
 * the second check, at the moment of posting. Prefix entries cannot be
 * matched there, but the script also refuses any app other than the one
 * classified here (`expectBundleId`), so a sub-id is covered by the pin.
 */
export function protectedBundleIds(env: NodeJS.ProcessEnv, kind: ScreenInputKind = "type"): string[] {
  const ids = [...BLOCKED_BUNDLE_IDS, ...hostBundleIds(env), ...BROWSER_BUNDLE_IDS, ...(kind === "click" ? [] : TERMINAL_BUNDLE_IDS)];
  return [...new Set(ids)];
}

/**
 * Why this kind of input to this app is refused, or `null` when it is
 * allowed (still behind the approval). Worded for the model: what to use
 * instead.
 */
export function protectedAppReason(
  bundleId: string | null | undefined,
  env: NodeJS.ProcessEnv,
  kind: ScreenInputKind = "type",
): string | null {
  const cls = screenAppClass(bundleId, env);
  if (cls === null) return "the target app could not be identified";
  if (cls === "blocked") {
    return `${bundleId} is protected (the agent's own terminal or app, system settings, credentials or a script runner)`;
  }
  if (cls === "browser") {
    return `${bundleId} is a web browser, which screen control only looks at; use the browser tool for web pages`;
  }
  if (cls === "terminal" && kind !== "click") {
    return `${bundleId} is a terminal or code editor, where screen control may click but not type or press keys; use os.shell.run for commands`;
  }
  return null;
}

const CMD = 0x100000;
const SHIFT = 0x20000;
const CTRL = 0x40000;
const ALT = 0x80000;
const KEY_TAB = 48;
const KEY_BACKTICK = 50;
const KEY_SPACE = 49;
const KEY_ESCAPE = 53;
const ARROWS = new Set([123, 124, 125, 126]);

/**
 * Chords that move input to another app, space or system surface than
 * the one approved: the app switcher, window cycling, Spotlight, space
 * and Mission Control switching, and the Force Quit dialog.
 */
export function refusedChordReason(chord: KeyChord): string | null {
  const mods = chord.flags & (CMD | SHIFT | CTRL | ALT);
  const cmd = (mods & CMD) !== 0;
  if (cmd && (chord.keyCode === KEY_TAB || chord.keyCode === KEY_BACKTICK)) {
    return `${chord.label} switches apps or windows`;
  }
  if (cmd && chord.keyCode === KEY_SPACE) return `${chord.label} opens Spotlight`;
  if ((mods & CTRL) !== 0 && chord.keyCode === KEY_SPACE) return `${chord.label} switches input source or opens a launcher`;
  if ((mods & CTRL) !== 0 && ARROWS.has(chord.keyCode)) return `${chord.label} switches spaces or opens Mission Control`;
  if (cmd && (mods & ALT) !== 0 && chord.keyCode === KEY_ESCAPE) return `${chord.label} opens Force Quit`;
  return null;
}
