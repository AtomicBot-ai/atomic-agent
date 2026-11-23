/**
 * Which paths a sandboxed stdio MCP server keeps readable (ATO-620).
 *
 * Safe Mode hides credential folders and the agent's state directory
 * from a server. A plugin server is installed inside that state
 * directory (`<stateDir>/plugins/installed/<name>`, see
 * `plugins/plugin-store.ts`), so its own code has to be opened again,
 * and nothing more:
 *
 * - the command's own folder (an absolute command);
 * - an absolute argument that names an existing file: that exact file,
 *   never its folder (`<stateDir>/config.json` must not reopen the whole
 *   state directory, `~/.ssh/known_hosts` must not reopen `~/.ssh`);
 * - a path inside an installed plugin opens that plugin's install
 *   folder, so a server started as `node <plugin>/server.js` can load
 *   its own modules;
 * - nothing inside a credential folder, and nothing else inside the
 *   state directory (`.env`, OAuth tokens, config), ever.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { SECRET_HOME_PATHS } from "../sandbox/os-sandbox.js";

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface McpKeepReadableInput {
  command: string;
  args: readonly string[];
  stateDir?: string;
  home?: string;
}

export function mcpServerKeepReadable(input: McpKeepReadableInput): string[] {
  const home = input.home ?? homedir();
  const secretDirs = SECRET_HOME_PATHS.flatMap((p) => {
    const named = join(home, p);
    const resolved = real(named);
    return resolved === named ? [named] : [named, resolved];
  });
  const state =
    input.stateDir === undefined
      ? []
      : [...new Set([resolve(input.stateDir), real(resolve(input.stateDir))])];
  const installedRoots = state.map((s) => join(s, "plugins", "installed"));

  /** The plugin install folder a path sits in, or null. */
  const pluginFolder = (p: string): string | null => {
    for (const root of installedRoots) {
      if (!isInside(p, root) || p === root) continue;
      const name = relative(root, p).split(sep)[0];
      if (name !== undefined && name.length > 0) return join(root, name);
    }
    return null;
  };

  /** A path that may be reopened, or null when it must stay hidden. */
  const allowed = (p: string): string | null => {
    const r = real(resolve(p));
    if (secretDirs.some((dir) => isInside(r, dir) || isInside(p, dir))) return null;
    const plugin = pluginFolder(r) ?? pluginFolder(resolve(p));
    if (plugin !== null) return plugin;
    if (state.some((dir) => isInside(r, dir) || isInside(p, dir))) return null;
    return r;
  };

  const out: string[] = [];
  if (isAbsolute(input.command) && existsSync(input.command)) {
    const folder = allowed(dirname(input.command));
    if (folder !== null) out.push(folder);
  }
  for (const arg of input.args) {
    if (!isAbsolute(arg) || !existsSync(arg)) continue;
    const file = allowed(arg);
    if (file !== null) out.push(file);
  }
  return [...new Set(out)];
}
