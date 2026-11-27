/**
 * ATO-2450: when the CLI `atag launch` should start is not installed,
 * offer to install it, the way `ollama launch` asks "Claude Code is not
 * installed. Install with npm?". Never silently: only in a terminal, only
 * after an explicit yes to a question that shows the exact command, and
 * only when npm is there. Without a terminal it prints the command and
 * exits 1, as before.
 */

import type { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { findOnPath } from "./cloudflared.js";
import { runChild } from "./launch-child.js";
import type { LaunchIntegration } from "./launch-integrations.js";

/**
 * A launchable file on PATH. On Windows an npm global install leaves both
 * a POSIX shell shim (`claude`, no extension) and `claude.cmd`; only the
 * second can be spawned, so the PATHEXT forms are tried first.
 */
export function findLaunchBinary(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  find: typeof findOnPath = findOnPath,
): string | null {
  if (platform === "win32") {
    for (const ext of [".exe", ".cmd", ".bat"]) {
      const found = find(`${binary}${ext}`, env, platform);
      if (found && found.toLowerCase().endsWith(ext)) return found;
    }
  }
  return find(binary, env, platform);
}

/** `npm install -g <package>` as one line, for the question and the hint. */
export function installCommandLine(integration: Pick<LaunchIntegration, "install">): string {
  return [integration.install.command, ...integration.install.args].join(" ");
}

export interface InstallDeps {
  readonly isTTY?: () => boolean;
  readonly ask?: (prompt: string) => Promise<string>;
  readonly findBinary: (binary: string) => string | null;
  readonly spawn: typeof nodeSpawn;
  readonly env: NodeJS.ProcessEnv;
  readonly writeErr: (text: string) => void;
}

/** The installed binary's path, or the exit code to stop with. */
export async function offerInstall(
  integration: LaunchIntegration,
  deps: InstallDeps,
): Promise<{ readonly path: string } | { readonly code: number }> {
  const line = installCommandLine(integration);
  const missing = `launch: ${integration.displayName} is not installed (no \`${integration.binary}\` on PATH).\n`;
  const isTTY = deps.isTTY ?? (() => process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!isTTY()) {
    deps.writeErr(`${missing}Install it with: ${line}\n`);
    return { code: 1 };
  }
  const tool = deps.findBinary(integration.install.command);
  if (!tool) {
    deps.writeErr(
      `${missing}Installing it needs ${integration.install.command} (Node.js, https://nodejs.org). Install Node.js, then run: ${line}\n`,
    );
    return { code: 1 };
  }
  deps.writeErr(missing);
  const answer = await (deps.ask ?? defaultAsk)(`Install it now? This runs: ${line}  [y/N] `);
  if (!/^y(es)?$/i.test(answer.trim())) {
    deps.writeErr(`launch: not installed. To install it yourself: ${line}\n`);
    return { code: 1 };
  }
  deps.writeErr(`launch: running ${line}\n`);
  const code = await runChild(tool, { env: {}, args: integration.install.args }, deps.env, deps.spawn, deps.writeErr);
  if (code !== 0) {
    deps.writeErr(`launch: the install did not finish (exit code ${code}); the output above says why. Try it yourself: ${line}\n`);
    return { code };
  }
  const path = deps.findBinary(integration.binary);
  if (!path) {
    deps.writeErr(
      `launch: ${integration.displayName} was installed, but \`${integration.binary}\` is not on PATH in this terminal yet. Open a new terminal and run this again.\n`,
    );
    return { code: 1 };
  }
  deps.writeErr(`launch: ${integration.displayName} installed.\n`);
  return { path };
}

async function defaultAsk(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(prompt);
  } catch {
    return "";
  } finally {
    rl.close();
  }
}
