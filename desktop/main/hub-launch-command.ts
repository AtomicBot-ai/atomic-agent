/**
 * ATO-2737: the command the Agents sheet's "Open on local model" button
 * types into a terminal (ATO-2172 added the button).
 *
 * It used to type a bare `atag launch claude`. A person who has only the
 * desktop app has no `atag` on PATH ("command not found"), and a person
 * with an older terminal install (0.6.x) gets an `atag` that has no
 * `launch` at all. The app ships its own agent, the same version as the
 * window, and that is the binary it starts as its sidecar
 * (agent-client.ts resolveBinary). So the command names that binary by its
 * full path, the way VS Code's and Cursor's "Install `code` command" point
 * at the CLI inside their own app bundle.
 *
 * The path is quoted for the shell the terminal opens:
 *   - macOS and Linux (zsh, bash, sh): POSIX single quotes, a `'` inside
 *     written as `'\''`, so a space ("/Applications/Atomic Agent.app/...")
 *     or `$` stays literal.
 *   - Windows (Windows Terminal's default profile, else PowerShell,
 *     terminal-pick.ts): PowerShell's call operator with a single-quoted
 *     path, `& 'C:\Program Files\...\atomic-agent.exe' launch claude`; a
 *     `'` inside is doubled. Single quotes, not double: PowerShell expands
 *     `$` and the backtick inside double quotes.
 * No binary found (a dev run with nothing built): the bare `atag` command,
 * as before.
 *
 * Pure: platform and path come in as arguments, so the unit test
 * (test/hub-launch-command.test.mjs) drives every platform from one Mac.
 */

import type { Platform } from "./platform.js";

/** The CLIs `atag launch` starts that the Agents sheet lists. */
export const HUB_LAUNCH_AGENTS = ["claude", "codex"] as const;
export type HubLaunchAgent = (typeof HUB_LAUNCH_AGENTS)[number];

export function isHubLaunchAgent(value: unknown): value is HubLaunchAgent {
  return typeof value === "string" && (HUB_LAUNCH_AGENTS as readonly string[]).includes(value);
}

/** One argument for a POSIX shell: single-quoted, `'` closed, escaped and reopened. */
export function posixQuote(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/**
 * One argument for PowerShell: single-quoted (no `$` or backtick expansion).
 * PowerShell also ends a single-quoted string at the typographic quotes
 * U+2018, U+2019, U+201A and U+201B (a Windows account named "D’Angelo"),
 * so each of those is doubled like `'`, as PowerShell's own
 * CodeGeneration.EscapeSingleQuotedStringContent does.
 */
export function powershellQuote(arg: string): string {
  return "'" + arg.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&") + "'";
}

/**
 * The line typed into the terminal: the app's own agent by full path, or
 * the bare `atag` when there is none. `binPath` is the binary the sidecar
 * runs (resolveBinary), or null.
 */
export function bundledLaunchCommand(agent: HubLaunchAgent, platform: Platform, binPath: string | null): string {
  const bin = typeof binPath === "string" ? binPath.trim() : "";
  // A path with a line break would split into two commands at the prompt.
  if (!bin || /[\r\n\0]/.test(bin)) return `atag launch ${agent}`;
  if (platform === "win32") return `& ${powershellQuote(bin)} launch ${agent}`;
  return `${posixQuote(bin)} launch ${agent}`;
}

export type HubLaunchAnswer =
  | { ok: true; command: string }
  | { ok: false; reason: "remote" | "invalid-agent"; message: string };

export const HUB_LAUNCH_REMOTE_MESSAGE =
  "This app is connected to an agent on another computer, so it cannot start Claude Code or Codex on a local model here.";

/**
 * The `hub:launchCommand` answer. Connected to an agent on another
 * computer there is no local agent to run against, so it is refused in
 * words (the same rule as `hub:scan`).
 */
export function hubLaunchAnswer(
  agent: unknown,
  deps: { isRemote: boolean; platform: Platform; binPath: string | null },
): HubLaunchAnswer {
  if (deps.isRemote) return { ok: false, reason: "remote", message: HUB_LAUNCH_REMOTE_MESSAGE };
  if (!isHubLaunchAgent(agent)) return { ok: false, reason: "invalid-agent", message: "Only Claude Code and Codex can be opened on the local model." };
  return { ok: true, command: bundledLaunchCommand(agent, deps.platform, deps.binPath) };
}
