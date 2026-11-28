/**
 * ATO-2172: run the launched coding CLI with this terminal attached and
 * hand its exit code back.
 */

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { constants as osConstants } from "node:os";

import type { LaunchPlan } from "./launch-integrations.js";

/** cmd.exe quoting for a Windows `.cmd` / `.bat` shim, which only runs through a shell. */
export function winQuote(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Run the CLI with this terminal and forward its exit code. While it runs,
 * Ctrl+C belongs to the CLI (it is in the same process group and gets the
 * signal itself), so this process ignores SIGINT and passes SIGTERM and
 * SIGHUP on.
 */
export function runChild(
  binaryPath: string,
  plan: Pick<LaunchPlan, "env" | "args">,
  baseEnv: NodeJS.ProcessEnv,
  spawn: typeof nodeSpawn,
  writeErr: (text: string) => void,
): Promise<number> {
  const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(binaryPath);
  const options: SpawnOptions = { stdio: "inherit", env: { ...baseEnv, ...plan.env }, ...(viaShell ? { shell: true } : {}) };
  const child = viaShell
    ? spawn(winQuote(binaryPath), plan.args.map(winQuote), options)
    : spawn(binaryPath, [...plan.args], options);
  const ignore = (): void => undefined;
  const forward = (sig: NodeJS.Signals) => (): void => {
    try {
      child.kill(sig);
    } catch {
      // Already gone.
    }
  };
  const onTerm = forward("SIGTERM");
  const onHup = forward("SIGHUP");
  process.on("SIGINT", ignore);
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onHup);
  const cleanup = (): void => {
    process.off("SIGINT", ignore);
    process.off("SIGTERM", onTerm);
    process.off("SIGHUP", onHup);
  };
  return new Promise((resolveCode) => {
    child.once("error", (err) => {
      cleanup();
      writeErr(`launch: could not run ${binaryPath}: ${err.message}\n`);
      resolveCode(1);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code !== null) return resolveCode(code);
      const num = signal ? (osConstants.signals as Record<string, number>)[signal] : undefined;
      resolveCode(num ? 128 + num : 1);
    });
  });
}
