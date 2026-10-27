import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * What an `os.shell.run` command gets on top of the filtered environment
 * (`buildCommandEnv`, ATO-347) so the user's ordinary installs work from
 * the agent the way they do in their own terminal (ATO-1252).
 *
 * Two additions, both fixed values the model cannot steer:
 *
 *  - Non-interactive switches that make installers answer their own
 *    questions or fail fast instead of waiting on a terminal that is not
 *    there. Only switches that change no result: Homebrew's auto-update
 *    and hints, apt's debconf frontend, pip's prompts, npx's "Ok to
 *    proceed?", git's credential prompt. Never `CI=1` — test runners and
 *    build tools change what they do under it. A value the user already
 *    exported wins.
 *  - PATH entries a desktop-launched agent misses: GUI apps on macOS
 *    start with `/usr/bin:/bin:/usr/sbin:/sbin`, so `brew`, `node` from
 *    nvm and `python` from pyenv were "command not found" although the
 *    user's terminal has them. The login shell's PATH (read once, when
 *    the bootstrap allows it) and the well-known toolchain folders that
 *    exist on disk are APPENDED after the inherited PATH: a binary the
 *    agent already found keeps winning, nothing new shadows it.
 *
 * Secret filtering is untouched: this runs after `buildCommandEnv` and
 * adds no variable read from the agent's own environment except PATH.
 */

export const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
  HOMEBREW_NO_AUTO_UPDATE: "1",
  HOMEBREW_NO_ENV_HINTS: "1",
  DEBIAN_FRONTEND: "noninteractive",
  PIP_NO_INPUT: "1",
  npm_config_yes: "true",
  GIT_TERMINAL_PROMPT: "0",
};

/**
 * Toolchain folders under the home directory, relative to it, that a
 * login shell usually adds. Only the ones that exist are used.
 */
const HOME_TOOLCHAIN_DIRS: readonly string[] = [
  ".local/bin",
  ".cargo/bin",
  ".bun/bin",
  ".deno/bin",
  "go/bin",
  ".npm-global/bin",
  ".volta/bin",
  ".pyenv/shims",
  ".pyenv/bin",
  ".rbenv/shims",
  ".asdf/shims",
  ".local/share/mise/shims",
  ".linuxbrew/bin",
];

const SYSTEM_TOOLCHAIN_DIRS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
  ],
  linux: [
    "/home/linuxbrew/.linuxbrew/bin",
    "/home/linuxbrew/.linuxbrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/snap/bin",
  ],
};

export interface ToolchainEnvOptions {
  platform?: NodeJS.Platform;
  home?: string;
  /** PATH as the user's login shell sets it, when known. */
  loginShellPath?: string;
  /** Test seam for the existence check. */
  exists?: (path: string) => boolean;
}

/**
 * `env` with the non-interactive switches filled in where unset and the
 * missing toolchain folders appended to PATH. Returns a new object.
 */
export function withToolchainEnv(
  env: NodeJS.ProcessEnv,
  options: ToolchainEnvOptions = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [name, value] of Object.entries(NON_INTERACTIVE_ENV)) {
    if (out[name] === undefined) out[name] = value;
  }
  if (platform === "win32") return out;
  const exists = options.exists ?? existsSync;
  const home = options.home ?? env.HOME ?? homedir();
  const pathKey = "PATH";
  const current = (out[pathKey] ?? "").split(delimiter).filter(Boolean);
  const seen = new Set(current);
  const extra: string[] = [];
  const add = (dir: string, mustExist: boolean) => {
    if (dir.length === 0 || seen.has(dir)) return;
    if (mustExist && !exists(dir)) return;
    seen.add(dir);
    extra.push(dir);
  };
  for (const dir of (options.loginShellPath ?? "").split(delimiter)) {
    // The login shell's own entries need no existence check: it is the
    // user's PATH, read from their shell.
    if (dir.startsWith("/")) add(dir, false);
  }
  for (const dir of SYSTEM_TOOLCHAIN_DIRS[platform] ?? []) add(dir, true);
  if (home.length > 0) {
    const nvmBin = nvmDefaultBin(env.NVM_DIR ?? join(home, ".nvm"), exists);
    if (nvmBin !== null) add(nvmBin, true);
    for (const rel of HOME_TOOLCHAIN_DIRS) add(join(home, rel), true);
  }
  if (extra.length > 0) out[pathKey] = [...current, ...extra].join(delimiter);
  return out;
}

/**
 * The `bin` folder of nvm's default Node: `alias/default` names a
 * version (`20`, `v20.11.1`, `lts/iron`); the newest installed version
 * matching it is used, or the newest installed one when the alias is
 * not a version number. `null` when nvm is not installed.
 */
export function nvmDefaultBin(
  nvmDir: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const versionsDir = join(nvmDir, "versions", "node");
  if (!exists(versionsDir)) return null;
  let installed: string[];
  try {
    installed = readdirSync(versionsDir).filter((name) => /^v\d+/.test(name));
  } catch {
    return null;
  }
  if (installed.length === 0) return null;
  installed.sort(compareVersionsDesc);
  let alias = "";
  try {
    alias = readFileSync(join(nvmDir, "alias", "default"), "utf8").trim();
  } catch {
    // no default alias: newest installed
  }
  const wanted = alias.replace(/^v/, "");
  const match = /^\d+(\.\d+){0,2}$/.test(wanted)
    ? installed.find((name) => name === `v${wanted}` || name.startsWith(`v${wanted}.`))
    : undefined;
  return join(versionsDir, match ?? installed[0]!, "bin");
}

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const LOGIN_PATH_MARKER = "__ATOMIC_AGENT_PATH__";
const LOGIN_SHELL_TIMEOUT_MS = 3_000;
let loginShellPathPromise: Promise<string | undefined> | null = null;

/**
 * PATH as the user's login shell builds it (`$SHELL -lic`), read once
 * per process and cached; `undefined` on Windows, without `$SHELL`, on
 * any error, or after 3 s (an rc file that prompts or hangs). The shell
 * gets the filtered environment, and only PATH is read back.
 */
export function readLoginShellPath(
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (loginShellPathPromise !== null) return loginShellPathPromise;
  loginShellPathPromise = new Promise((resolve) => {
    const shell = env.SHELL;
    if (process.platform === "win32" || shell === undefined || !shell.startsWith("/")) {
      resolve(undefined);
      return;
    }
    try {
      execFile(
        shell,
        ["-lic", `printf '%s%s%s' ${LOGIN_PATH_MARKER} "$PATH" ${LOGIN_PATH_MARKER}`],
        { env, timeout: LOGIN_SHELL_TIMEOUT_MS, encoding: "utf8", maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            resolve(undefined);
            return;
          }
          const parts = String(stdout).split(LOGIN_PATH_MARKER);
          resolve(parts.length >= 3 && parts[1]!.length > 0 ? parts[1] : undefined);
        },
      ).stdin?.end();
    } catch {
      resolve(undefined);
    }
  });
  return loginShellPathPromise;
}

/** Test seam: forget the cached login-shell PATH. */
export function resetLoginShellPathCache(): void {
  loginShellPathPromise = null;
}
