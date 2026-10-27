import type { KeyChord } from "./screen-keys.js";

/**
 * Apps the screen tools never click into or type into, at any approval
 * level and whatever the session was granted.
 *
 * The reason is self-escalation: the agent's own terminal (or Atomic
 * Agent Desktop) accepts slash commands, so one keystroke sequence like
 * "/mode bypass" + return would raise the approval level from inside a
 * turn. Every terminal and terminal-hosting IDE is on the list because
 * the agent may run in any of them; System Settings, the keychain, the
 * login / security prompts and password managers because input there
 * grants permissions or reveals secrets; Script Editor and Automator
 * because they post input of their own, outside this guard.
 */
export const PROTECTED_BUNDLE_IDS: readonly string[] = [
  // Atomic Agent itself.
  "io.atomicagent.desktop",
  // Terminals.
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "dev.warp.Warp-Stable",
  "com.mitchellh.ghostty",
  "net.kovidgoyal.kitty",
  "org.alacritty",
  "com.github.wez.wezterm",
  // Editors with a built-in terminal.
  "com.microsoft.VSCode",
  "com.todesktop.230313mzl4w4u92", // Cursor
  "dev.zed.Zed",
  // Permissions, credentials, the login and security prompts.
  "com.apple.systempreferences",
  "com.apple.Settings",
  "com.apple.keychainaccess",
  "com.apple.SecurityAgent",
  "com.apple.loginwindow",
  "com.1password.1password",
  "com.bitwarden.desktop",
  // Apps that run scripts which post input themselves.
  "com.apple.ScriptEditor2",
  "com.apple.Automator",
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

/** The static list plus the host app, deduplicated — also sent to the JXA guard. */
export function protectedBundleIds(env: NodeJS.ProcessEnv): string[] {
  return [...new Set([...PROTECTED_BUNDLE_IDS, ...hostBundleIds(env)])];
}

/**
 * Why input to this app is refused, or `null` when it is allowed. An app
 * whose bundle id is unknown is refused too: the guard cannot vouch for
 * a target it cannot name.
 */
export function protectedAppReason(
  bundleId: string | null | undefined,
  env: NodeJS.ProcessEnv,
): string | null {
  if (!bundleId) return "the target app could not be identified";
  const lower = bundleId.toLowerCase();
  if (protectedBundleIds(env).some((id) => id.toLowerCase() === lower)) {
    return `${bundleId} is protected (the agent's own terminal or app, a terminal, system settings, credentials or a script runner)`;
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
