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
 *   2. `ast-grep` on `PATH`. On Windows only `ast-grep.exe` is taken;
 *      an npm `.cmd` shim is followed to the native `.exe` it wraps.
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
  const separator = platform === "win32" ? ";" : delimiter;
  for (const segment of pathVar.split(separator)) {
    if (segment.length === 0) continue;
    if (platform !== "win32") {
      const full = join(segment, "ast-grep");
      if (fileExists(full)) return full;
      continue;
    }
    // Windows: only a real .exe can be spawned without a shell. npm's
    // `ast-grep.cmd` (and the extensionless sh script beside it) is a
    // shim; spawning it with shell:false fails with EINVAL, and running
    // it through cmd.exe would mean re-quoting every pattern for cmd.
    // So a shim is followed to the native binary npm installed next to
    // it, and skipped when there is none.
    const exe = join(segment, "ast-grep.exe");
    if (fileExists(exe)) return exe;
    const hasShim = ["ast-grep.cmd", "ast-grep.bat", "ast-grep"].some((name) =>
      fileExists(join(segment, name)),
    );
    if (!hasShim) continue;
    for (const candidate of npmNativeCandidates(segment)) {
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Where `npm install -g @ast-grep/cli` puts the native Windows binary,
 * relative to the folder holding the `ast-grep.cmd` shim: the package's
 * own copy, then the platform package nested under it or hoisted.
 */
export function npmNativeCandidates(shimDir: string): string[] {
  const modules = join(shimDir, "node_modules", "@ast-grep");
  const platforms = ["cli-win32-x64-msvc", "cli-win32-arm64-msvc", "cli-win32-ia32-msvc"];
  return [
    join(modules, "cli", "ast-grep.exe"),
    ...platforms.map((p) => join(modules, "cli", "node_modules", "@ast-grep", p, "ast-grep.exe")),
    ...platforms.map((p) => join(modules, p, "ast-grep.exe")),
  ];
}

function defaultFileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
