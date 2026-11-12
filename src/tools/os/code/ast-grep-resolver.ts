import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Where the `ast-grep` CLI lives, or null. ast-grep is not bundled: it
 * is a native binary per platform, so the structural code tools use the
 * one the user installed (`brew install ast-grep`, `npm i -g
 * @ast-grep/cli`, `cargo install ast-grep`, `pip install ast-grep-cli`).
 *
 * Lookup order:
 *   1. `ATOMIC_AGENT_AST_GREP_PATH` — explicit path (tests, odd layouts).
 *   2. `ast-grep` on `PATH` (`.exe` / `.cmd` / `.bat` on Windows).
 *
 * The short alias `sg` is deliberately not tried: on Linux it is also
 * the shadow-utils "switch group" command.
 *
 * Not memoised: PATH is scanned per call (cheap), so a user who
 * installs ast-grep mid-session does not need a restart.
 */

export interface AstGrepResolverOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fileExists?: (path: string) => boolean;
}

export const AST_GREP_MISSING_HINT =
  "the ast-grep CLI was not found. Ask the user to install it (macOS: `brew install ast-grep`; any OS with Node: `npm install -g @ast-grep/cli`; or `cargo install ast-grep` / `pip install ast-grep-cli`), or set ATOMIC_AGENT_AST_GREP_PATH to the binary. Until then use os.fs.grep for a text search.";

export function resolveAstGrepPath(
  options: AstGrepResolverOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? defaultFileExists;

  const override = env.ATOMIC_AGENT_AST_GREP_PATH;
  if (typeof override === "string" && override.length > 0 && fileExists(override)) {
    return override;
  }

  const pathVar = env.PATH ?? env.Path ?? env.path ?? "";
  if (pathVar.length === 0) return null;
  const names =
    platform === "win32"
      ? ["ast-grep.exe", "ast-grep.cmd", "ast-grep.bat", "ast-grep"]
      : ["ast-grep"];
  const separator = platform === "win32" ? ";" : delimiter;
  for (const segment of pathVar.split(separator)) {
    if (segment.length === 0) continue;
    for (const name of names) {
      const full = join(segment, name);
      if (fileExists(full)) return full;
    }
  }
  return null;
}

function defaultFileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
