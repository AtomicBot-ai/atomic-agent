import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { getUserConfigPath, loadConfig, resolveStateDir, type AtomicAgentConfig } from "../config/index.js";
import { readRawConfigTree, writeRawUserConfigFileSync } from "../config/config-paths.js";
import { runEngineChecks, type EngineProbes } from "./doctor-engine-checks.js";
import { findOnPath, runDoctorChecks, type DoctorContext, type DoctorFinding } from "./doctor-checks.js";

/**
 * ATO-577 — `atag doctor`: check config, its file mode and MCP commands;
 * `--fix` applies the bounded fixes after copying config.json into
 * `<stateDir>/doctor-backups/`; `--undo` puts the newest copy back.
 * Once the config is valid, the local engine (installed, model on disk,
 * memory, server and its port) or the active cloud provider's key is
 * checked too (doctor-engine-checks.ts); those say the command that fixes them.
 */
const HELP = [
  "Usage: atomic-agent doctor [--fix] [--undo] [--json]",
  "",
  "Check this install for problems the agent can name, and fix the bounded ones.",
  "Checks config.json, its file mode, MCP commands, then the local engine",
  "(installed, model on disk, memory, server, port) or the cloud key (one test token).",
  "",
  "Options:",
  "  --fix      Apply the fixes listed (config.json is backed up first)",
  "  --undo     Restore config.json from the newest doctor backup",
  "  --json     Print the findings as JSON",
  "  -h, --help Show this help",
].join("\n");

export interface DoctorCommandDeps {
  stateDir?: string;
  write?: (text: string) => void;
  writeErr?: (text: string) => void;
  context?: Partial<DoctorContext>;
  now?: () => Date;
  /** null skips the engine and key checks (tests of the config checks). */
  engine?: EngineProbes | null;
  loadConfig?: () => AtomicAgentConfig;
}

const MARK = { ok: "ok  ", warn: "warn", fail: "FAIL" } as const;

function backupDir(stateDir: string): string {
  return join(stateDir, "doctor-backups");
}

function newestBackup(stateDir: string): string | null {
  const dir = backupDir(stateDir);
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir).filter((n) => /^config-.*\.json$/.test(n)).sort();
  return names.length ? join(dir, names[names.length - 1]!) : null;
}

function print(findings: DoctorFinding[], write: (t: string) => void): void {
  for (const f of findings) {
    write(`${MARK[f.status]}  ${f.check}: ${f.message}\n`);
    if (f.fix) write(`      fix: ${f.fix.describe}\n`);
  }
}

export async function doctorCommand(args: string[], deps: DoctorCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const known = new Set(["--fix", "--undo", "--json", "-h", "--help"]);
  const unknown = args.find((a) => !known.has(a));
  if (unknown || args.includes("-h") || args.includes("--help")) {
    write(`${unknown ? `unknown option ${unknown}\n\n` : ""}${HELP}\n`);
    return unknown ? 2 : 0;
  }
  if (args.includes("--fix") && args.includes("--undo")) {
    write("--fix and --undo do not go together\n");
    return 2;
  }
  const stateDir = deps.stateDir ?? resolveStateDir();
  const configPath = getUserConfigPath(stateDir);

  if (args.includes("--undo")) {
    const backup = newestBackup(stateDir);
    if (!backup) {
      write(`no doctor backup in ${backupDir(stateDir)}; nothing to undo\n`);
      return 1;
    }
    copyFileSync(backup, configPath);
    chmodSync(configPath, 0o600);
    rmSync(backup);
    write(`restored ${configPath} from ${backup}\n`);
    return 0;
  }

  const ctx: DoctorContext = {
    stateDir,
    configPath,
    platform: process.platform,
    findOnPath: (c) => findOnPath(c),
    chmod: (p, m) => chmodSync(p, m),
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        // EPERM: it runs under another user, so it is alive.
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    now: deps.now ?? (() => new Date()),
    ...deps.context,
  };
  // With --json, stdout is the findings array alone; what --fix did goes to stderr.
  const say = args.includes("--json") ? (deps.writeErr ?? ((t: string) => { process.stderr.write(t); })) : write;
  let findings = runDoctorChecks(ctx);
  const fixable = findings.filter((f) => f.fix);

  if (args.includes("--fix") && fixable.length) {
    const treeFixes = fixable.filter((f) => f.fix!.tree);
    if (treeFixes.length) {
      const dir = backupDir(stateDir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stamp = (deps.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
      const backup = join(dir, `config-${stamp}.json`);
      copyFileSync(configPath, backup);
      chmodSync(backup, 0o600);
      const tree = readRawConfigTree(configPath);
      for (const f of treeFixes) f.fix!.tree!(tree);
      writeRawUserConfigFileSync(configPath, tree);
      say(`backed up config.json to ${backup} (atag doctor --undo puts it back)\n`);
    }
    for (const f of fixable) {
      f.fix!.file?.();
      say(`fixed  ${f.check}: ${f.fix!.describe}\n`);
    }
    findings = runDoctorChecks(ctx);
  }

  // The engine and the key are read from the loaded config, once, and only while config.json is valid.
  if (deps.engine !== null && !findings.some((f) => f.check === "config" && f.status === "fail")) {
    try {
      const cfg = (deps.loadConfig ?? loadConfig)();
      findings = [...findings, ...(await runEngineChecks(cfg, deps.engine ?? undefined))];
    } catch (err) {
      findings = [...findings, { check: "engine", status: "warn", message: `could not read the engine state: ${err instanceof Error ? err.message : String(err)}` }];
    }
  }

  if (args.includes("--json")) {
    write(JSON.stringify(findings.map(({ fix, ...f }) => ({ ...f, ...(fix ? { fix: fix.describe } : {}) })), null, 2) + "\n");
  } else {
    print(findings, write);
    const left = findings.filter((f) => f.fix).length;
    if (left && !args.includes("--fix")) write(`\n${left} fixable; run \`atag doctor --fix\`\n`);
  }
  return findings.some((f) => f.status === "fail") ? 1 : 0;
}
