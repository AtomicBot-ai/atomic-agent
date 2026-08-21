import { createInterface } from "node:readline/promises";

import { getConfig } from "../config/index.js";
import {
  checkForAppUpdate,
  runAppUpdate,
  canSelfUpdate,
} from "../update/index.js";

/**
 * Dependency seam for `updateCommand`. Defaults to the real
 * `src/update/` functions; tests inject stubs so nothing spawns a
 * process or hits the network. All deps are optional.
 */
export interface UpdateCommandDeps {
  checkForAppUpdate?: typeof checkForAppUpdate;
  runAppUpdate?: typeof runAppUpdate;
  canSelfUpdate?: typeof canSelfUpdate;
  /** Resolves the `update.repo` config value. Defaults to `getConfig().update.repo`. */
  getRepo?: () => string;
  /** Whether the command is attached to a TTY. Defaults to stdout. */
  isTTY?: () => boolean;
  /** Interactive y/n confirmation. Defaults to a readline prompt. */
  confirm?: (prompt: string) => Promise<boolean>;
}

const HELP = [
  "atomic-agent update — self-update the installed binary from GitHub Releases",
  "",
  "Checks GitHub Releases for a newer published version and re-runs the",
  "canonical installer (install.sh / install.ps1) in place, exactly like the",
  "TUI's in-app update. Only meaningful for the installed SEA binary — a dev",
  "checkout is updated via git. The running process is not restarted; the",
  "next launch picks up the new binary.",
  "",
  "Flags:",
  "  --check              Check only: report current vs latest, install nothing",
  "  --version <tag>      Install a specific release tag (e.g. v0.3.2) instead of latest",
  "  -h, --help           Show this help",
  "",
  "Exit codes:",
  "  0  success (up to date, updated, or --check ran fine)",
  "  1  operational failure (check failed, not self-updatable, installer failed)",
  "  2  usage error (unknown flag, missing --version value, conflicting flags)",
  "",
  "Examples:",
  "  atomic-agent update",
  "  atomic-agent update --check",
  "  atomic-agent update --version v0.3.2",
].join("\n") + "\n";

/** Parse flags into a discriminated plan; returns a usage error string on bad input. */
function parseArgs(
  args: string[],
): { ok: true; checkOnly: boolean; version?: string } | { ok: false; error: string } {
  let checkOnly = false;
  let version: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      return { ok: true, checkOnly: false };
    }
    if (arg === "--check") {
      checkOnly = true;
      continue;
    }
    if (arg === "--version") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        return { ok: false, error: "--version requires a tag (e.g. v0.3.2)" };
      }
      version = value;
      i += 1;
      continue;
    }
    return { ok: false, error: `unknown option: ${arg}` };
  }
  if (checkOnly && version) {
    return {
      ok: false,
      error: "--check and --version are mutually exclusive",
    };
  }
  return { ok: true, checkOnly, version };
}

async function defaultConfirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(prompt);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * `atomic-agent update` — check GitHub Releases and re-run the canonical
 * installer in place when a newer version exists. Mirrors the TUI's
 * in-app update for headless / `run` / sidecar users who never see it.
 *
 * Exit codes follow the documented CLI contract: 0 success, 1 operational
 * failure, 2 usage error.
 */
export async function updateCommand(
  args: string[],
  deps: UpdateCommandDeps = {},
): Promise<number> {
  const check = deps.checkForAppUpdate ?? checkForAppUpdate;
  const run = deps.runAppUpdate ?? runAppUpdate;
  const canSelf = deps.canSelfUpdate ?? canSelfUpdate;
  const getRepo = deps.getRepo ?? (() => getConfig().update.repo);
  const isTTY = deps.isTTY ?? (() => process.stdout.isTTY === true);
  const confirm = deps.confirm ?? defaultConfirm;
  const repo = getRepo();

  const parsed = parseArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  if (args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    // --version installs a pinned tag regardless of what "latest" says;
    // it still refuses dev builds and still confirms interactively.
    if (parsed.version) {
      if (!canSelf()) {
        process.stderr.write(
          "self-update is only supported for the installed binary; " +
            "update via git in development\n",
        );
        return 1;
      }
      process.stdout.write(`installing ${parsed.version}…\n`);
      if (isTTY()) {
        const ok = await confirm(`update to ${parsed.version}? [y/N] `);
        if (!ok) {
          process.stdout.write("update cancelled\n");
          return 0;
        }
      }
      await run({ repo, version: parsed.version, onLine: streamUpdateLine });
      process.stdout.write(`updated to ${parsed.version}\n`);
      return 0;
    }

    const result = await check({ repo });
    if (parsed.checkOnly) {
      if (!result.updateAvailable) {
        process.stdout.write(`up to date (${result.currentVersion})\n`);
      } else {
        process.stdout.write(
          `update available: ${result.currentVersion} → ${result.latestVersion}\n`,
        );
      }
      return 0;
    }

    if (!result.updateAvailable) {
      process.stdout.write(`up to date (${result.currentVersion})\n`);
      return 0;
    }
    if (!canSelf()) {
      process.stderr.write(
        "self-update is only supported for the installed binary; " +
          "update via git in development\n",
      );
      return 1;
    }

    process.stdout.write(
      `current: ${result.currentVersion} → latest: ${result.latestVersion}\n`,
    );
    if (isTTY()) {
      const ok = await confirm(`update to ${result.latestVersion}? [y/N] `);
      if (!ok) {
        process.stdout.write("update cancelled\n");
        return 0;
      }
    }
    await run({
      repo,
      version: undefined,
      onLine: streamUpdateLine,
    });
    process.stdout.write(`updated to ${result.latestVersion}\n`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`update failed: ${message}\n`);
    return 1;
  }
}

/** Stream installer stdout/stderr lines to the terminal, one per line. */
function streamUpdateLine(line: string): void {
  process.stdout.write(`[update] ${line}\n`);
}
