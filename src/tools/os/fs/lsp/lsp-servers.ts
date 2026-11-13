/**
 * Which language servers the after-edit diagnostics may start, and how
 * to find them. Only servers the user already has on PATH are used:
 * nothing is downloaded or installed, ever.
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, extname, join, parse } from "node:path";

export type LspServerId = "typescript" | "pyright";

export interface LspServerSpec {
  readonly id: LspServerId;
  /** Binary looked up on PATH. */
  readonly command: string;
  readonly args: readonly string[];
  readonly extensions: ReadonlySet<string>;
  languageId(path: string): string;
}

const TS_LANGUAGE_IDS: Readonly<Record<string, string>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
};

export const LSP_SERVERS: readonly LspServerSpec[] = [
  {
    id: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: new Set(Object.keys(TS_LANGUAGE_IDS)),
    languageId: (path) =>
      TS_LANGUAGE_IDS[extname(path).toLowerCase()] ?? "typescript",
  },
  {
    id: "pyright",
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: new Set([".py", ".pyi"]),
    languageId: () => "python",
  },
];

/** The server for `path`, or null when no supported language owns it. */
export function serverForPath(path: string): LspServerSpec | null {
  const ext = extname(path).toLowerCase();
  return LSP_SERVERS.find((spec) => spec.extensions.has(ext)) ?? null;
}

/**
 * Absolute path of `name` on PATH, or null. On Windows the PATHEXT
 * variants (`.cmd` shims from npm) are tried too.
 */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const pathVar = env.PATH ?? env.Path ?? "";
  const sep = platform === "win32" ? ";" : delimiter;
  const exts =
    platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)]
      : [""];
  for (const dir of pathVar.split(sep)) {
    if (dir.length === 0) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase());
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The git work tree holding `dir` (the nearest folder with a `.git`
 * entry, a directory or a worktree's file), or null. A repository at
 * the home folder or a filesystem root does not count: a dotfiles repo
 * at `~` must not make every file under home a "project".
 */
export function findGitRoot(
  dir: string,
  home: string = homedir(),
): string | null {
  let current = dir;
  for (;;) {
    if (existsSync(join(current, ".git"))) {
      if (current === home || current === parse(current).root) return null;
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
