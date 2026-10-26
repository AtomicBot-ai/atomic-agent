import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { getUserConfigPath, resolveStateDir } from "../config/index.js";
import { readRawConfigTree, writeRawUserConfigFileSync } from "../config/config-paths.js";
import { findOnPath, runDoctorChecks, type DoctorContext, type DoctorFinding } from "./doctor-checks.js";

/**
 * ATO-577 — `atag doctor`: check config, its file mode and MCP commands;
 * `--fix` applies the bounded fixes after copying config.json into
 * `<stateDir>/doctor-backups/`; `--undo` puts the newest copy back.
 * First version: the engine and cloud provider keys are not checked yet.
 */
const HELP = [
  "Usage: atomic-agent doctor [--fix] [--undo] [--json]",
  "",
  "Check this install for problems the agent can name, and fix the bounded ones.",
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
  context?: Partial<DoctorContext>;
  now?: () => Date;
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
    ...deps.context,
  };
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
      write(`backed up config.json to ${backup} (atag doctor --undo puts it back)\n`);
    }
    for (const f of fixable) {
      f.fix!.file?.();
      write(`fixed  ${f.check}: ${f.fix!.describe}\n`);
    }
    findings = runDoctorChecks(ctx);
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
