/**
 * Which language servers the after-edit diagnostics and `os.code.lsp`
 * may start, and how to find them. Only servers the user already has on
 * PATH are used: nothing is downloaded or installed, ever. The list
 * follows OpenCode's built-in servers (ATO-2373).
 */
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, extname, join, parse } from "node:path";

export type LspServerId =
  | "typescript"
  | "pyright"
  | "gopls"
  | "rust-analyzer"
  | "clangd"
  | "jdtls"
  | "sourcekit-lsp"
  | "csharp-ls";

export interface LspServerSpec {
  readonly id: LspServerId;
  /** Binary looked up on PATH. */
  readonly command: string;
  readonly args: readonly string[];
  /** Arguments that depend on the work tree; win over `args` when set. */
  argsFor?(rootDir: string): readonly string[];
  readonly extensions: ReadonlySet<string>;
  languageId(path: string): string;
}

const C_EXTENSIONS: ReadonlySet<string> = new Set([".c", ".h"]);
const CPP_EXTENSIONS: readonly string[] = [".cc", ".cpp", ".cxx", ".c++", ".hh", ".hpp", ".hxx"];

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
  {
    id: "gopls",
    command: "gopls",
    args: [],
    extensions: new Set([".go"]),
    languageId: () => "go",
  },
  {
    id: "rust-analyzer",
    command: "rust-analyzer",
    args: [],
    extensions: new Set([".rs"]),
    languageId: () => "rust",
  },
  {
    id: "clangd",
    command: "clangd",
    args: [],
    extensions: new Set([...C_EXTENSIONS, ...CPP_EXTENSIONS]),
    languageId: (path) =>
      C_EXTENSIONS.has(extname(path).toLowerCase()) ? "c" : "cpp",
  },
  {
    id: "jdtls",
    command: "jdtls",
    args: [],
    // jdtls keeps its index in a data folder: one per work tree, under
    // the system temp folder, never inside the project.
    argsFor: (rootDir) => ["-data", jdtlsDataDir(rootDir)],
    extensions: new Set([".java"]),
    languageId: () => "java",
  },
  {
    id: "sourcekit-lsp",
    command: "sourcekit-lsp",
    args: [],
    extensions: new Set([".swift"]),
    languageId: () => "swift",
  },
  {
    id: "csharp-ls",
    command: "csharp-ls",
    args: [],
    extensions: new Set([".cs"]),
    languageId: () => "csharp",
  },
];

/** The arguments a server starts with in `rootDir`. */
export function serverArgs(spec: LspServerSpec, rootDir: string): readonly string[] {
  return spec.argsFor?.(rootDir) ?? spec.args;
}

function jdtlsDataDir(rootDir: string): string {
  const key = createHash("sha256").update(rootDir).digest("hex").slice(0, 16);
  return join(tmpdir(), "atomic-agent-jdtls", key);
}

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
