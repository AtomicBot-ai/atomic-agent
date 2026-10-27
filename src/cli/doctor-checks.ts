import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import { ConfigValidationError, parseUserConfigFile } from "../config/index.js";
import { readRawConfigTree } from "../config/config-paths.js";
import { checkCoreLocks } from "./doctor-core-lock.js";

/**
 * ATO-577 — `atag doctor`: a registry of checks, each of which can find one
 * kind of problem and, where the repair is bounded, offer a fix. A fix
 * either edits the raw config tree (the command backs the file up first and
 * `--undo` puts it back) or acts on the file itself (its mode). Nothing here
 * writes; the command does, and only under `--fix`.
 */
export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorFix {
  /** What the fix will do, said before it is done. */
  describe: string;
  /** Edits the raw config tree in place. */
  tree?: (tree: Record<string, unknown>) => void;
  /** Acts outside the tree (e.g. file mode). */
  file?: () => void;
}

export interface DoctorFinding {
  check: string;
  status: DoctorStatus;
  message: string;
  fix?: DoctorFix;
}

export interface DoctorContext {
  stateDir: string;
  configPath: string;
  platform: NodeJS.Platform;
  /** PATH lookup for a bare command; injectable for tests. */
  findOnPath: (command: string) => boolean;
  chmod: (path: string, mode: number) => void;
  /** Whether a process id is running; injectable for tests. */
  pidAlive: (pid: number) => boolean;
  now: () => Date;
}

type Tree = Record<string, unknown>;

function asObject(value: unknown): Tree | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Tree) : null;
}

/** The config file reads as JSON and passes this build's schema. */
function checkConfig(ctx: DoctorContext): DoctorFinding[] {
  if (!existsSync(ctx.configPath)) {
    return [{ check: "config", status: "ok", message: `no ${ctx.configPath} yet; defaults apply` }];
  }
  let tree: Tree;
  try {
    tree = readRawConfigTree(ctx.configPath);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return [{ check: "config", status: "fail", message: `${why} (fix the file by hand; doctor does not guess at broken JSON)` }];
  }
  try {
    parseUserConfigFile(tree);
    return [{ check: "config", status: "ok", message: `${ctx.configPath} is valid` }];
  } catch (err) {
    if (!(err instanceof ConfigValidationError)) throw err;
    if (err.field === "llm.activeTextProvider") {
      const providers = Array.isArray(asObject(tree.llm)?.providers) ? (asObject(tree.llm)!.providers as unknown[]) : [];
      const first = providers.map(asObject).find((p) => typeof p?.id === "string")?.id as string | undefined;
      if (first) {
        return [{
          check: "config",
          status: "fail",
          message: `llm.activeTextProvider: ${err.reason}`,
          fix: {
            describe: `set llm.activeTextProvider to "${first}", the first configured provider`,
            tree: (t) => { asObject(t.llm)!.activeTextProvider = first; },
          },
        }];
      }
    }
    return [{ check: "config", status: "fail", message: `${err.field}: ${err.reason} (no automatic fix; \`atag config set\` or edit the file)` }];
  }
}

/** config.json holds API keys: readable by its owner only. */
function checkConfigMode(ctx: DoctorContext): DoctorFinding[] {
  if (ctx.platform === "win32" || !existsSync(ctx.configPath)) return [];
  const mode = statSync(ctx.configPath).mode & 0o777;
  if ((mode & 0o077) === 0) return [{ check: "config-mode", status: "ok", message: "config.json is readable by its owner only" }];
  return [{
    check: "config-mode",
    status: "warn",
    message: `config.json is mode ${mode.toString(8)}; other users on this computer can read the API keys in it`,
    fix: { describe: "chmod 600 config.json", file: () => ctx.chmod(ctx.configPath, 0o600) },
  }];
}

function commandExists(command: string, ctx: DoctorContext): boolean {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) return existsSync(command);
  return ctx.findOnPath(command);
}

/** An enabled stdio MCP server whose command is not installed fails every start. */
function checkMcpCommands(ctx: DoctorContext): DoctorFinding[] {
  let tree: Tree;
  try {
    tree = readRawConfigTree(ctx.configPath);
  } catch {
    return [];
  }
  const servers = asObject(tree.mcp)?.servers;
  if (!Array.isArray(servers)) return [];
  const out: DoctorFinding[] = [];
  servers.forEach((raw, i) => {
    const server = asObject(raw);
    const transport = asObject(server?.transport);
    // `enabled` goes through parseBool in the schema: "false", "0", "off", "no" are off too.
    const off = server?.enabled === false || (typeof server?.enabled === "string" && ["false", "0", "off", "no"].includes(server.enabled.toLowerCase()));
    if (!server || off || transport?.kind !== "stdio" || typeof transport.command !== "string") return;
    const name = typeof server.name === "string" ? server.name : `#${i}`;
    if (commandExists(transport.command, ctx)) {
      out.push({ check: "mcp", status: "ok", message: `${name}: ${transport.command} found` });
      return;
    }
    out.push({
      check: "mcp",
      status: "warn",
      message: `${name}: command "${transport.command}" is not installed, so this MCP server cannot start`,
      fix: {
        describe: `turn MCP server ${name} off (mcp.servers[${i}].enabled = false); install the command and turn it back on`,
        tree: (t) => {
          const s = asObject((asObject(t.mcp)?.servers as unknown[] | undefined)?.[i]);
          if (s) s.enabled = false;
        },
      },
    });
  });
  return out;
}

export const DOCTOR_CHECKS: ReadonlyArray<(ctx: DoctorContext) => DoctorFinding[]> = [
  checkConfig,
  checkConfigMode,
  checkMcpCommands,
  checkCoreLocks,
];

export function runDoctorChecks(ctx: DoctorContext): DoctorFinding[] {
  return DOCTOR_CHECKS.flatMap((check) => check(ctx));
}

/** `which`, without spawning: PATH entries (plus PATHEXT on Windows) that hold an executable file. */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const exts = platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        const path = join(dir, command + ext);
        accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
        if (statSync(path).isFile()) return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}
