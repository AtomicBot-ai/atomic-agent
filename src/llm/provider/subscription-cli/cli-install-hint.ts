import type { SubscriptionCliName } from "../../../config/llm-config.js";

/**
 * What to install when Claude Code or Codex is not there, in the words
 * of the platform the person is on (ATO-1679).
 *
 * A turn on a missing CLI ends on `SubscriptionCliNotInstalledError`,
 * and its message is the only next step the person gets. It used to say
 * "Install Claude Code and sign in" with no command, so a Windows user
 * (CLI-HP) was left to find one; now it names the vendor's own installer
 * for the platform, the same one the desktop's setup step shows
 * (`subscriptionInstallCommand`), and the Windows file names a `binPath`
 * points at.
 *
 * Precedent: Claude Code's setup page gives `irm .../install.ps1 | iex`
 * for PowerShell and `curl -fsSL .../install.sh | bash` elsewhere; the
 * Codex README gives `npm install -g @openai/codex`.
 */

/** The install command for this platform, as the desktop's step shows it. */
export function subscriptionInstallCommand(cli: SubscriptionCliName, platform: NodeJS.Platform): string {
  if (cli === "claude") {
    return platform === "win32"
      ? "irm https://claude.ai/install.ps1 | iex"
      : "curl -fsSL https://claude.ai/install.sh | bash";
  }
  return "npm install -g @openai/codex";
}

/** The sentence after "Claude Code isn't installed (...)." for this platform. */
export function cliInstallHint(cli: SubscriptionCliName, platform: NodeJS.Platform): string {
  const win = platform === "win32";
  const install = subscriptionInstallCommand(cli, platform);
  const shell = win ? "PowerShell" : "Terminal";
  if (cli === "claude") {
    const where = win
      ? "the full path of claude.exe (for example C:\\Users\\you\\.local\\bin\\claude.exe)"
      : "the binary's absolute path";
    return `Install it in ${shell} with \`${install}\`, run \`claude\` once to sign in, then restart Atomic Agent. Or choose another provider. If it is installed somewhere else, set llm.providers[].subscriptionCli.binPath to ${where}.`;
  }
  const where = win
    ? "the full path of codex.cmd (for example C:\\Users\\you\\AppData\\Roaming\\npm\\codex.cmd)"
    : "the binary's absolute path";
  return `Install it in ${shell} with \`${install}\` (it needs Node.js from https://nodejs.org), run \`codex login\`, then restart Atomic Agent. Or choose another provider. If it is installed somewhere else, set llm.providers[].subscriptionCli.binPath to ${where}.`;
}
