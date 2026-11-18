import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { getConfig, resolveStateDir } from "../config/index.js";
import { MemoryStore, ProfileStore } from "../memory/index.js";
import { SessionStore } from "../session/index.js";
import { listStarterSkillNames } from "../skills/index.js";
import { TaskStore } from "../tasks/index.js";
import { exportSetup, importSetup, SetupBundleError, type ImportSetupResult, type SetupManifest } from "../setup-share/index.js";
import { getAppVersion } from "../version.js";

/**
 * ATO-1073 — `atag setup export|import`: share an agent setup (skills,
 * subagent profiles, MCP servers, cloud providers, personas) without the
 * keys, the way Hermes shares a profile. The logic lives in
 * src/setup-share/; this file only parses flags and prints.
 */
const HELP = [
  "Usage: atomic-agent setup <command>",
  "",
  "Share your agent setup with someone else. API keys, tokens and passwords are",
  "always taken out; chats, logs and caches never go in.",
  "",
  "Commands:",
  "  export [-o <file.tar.gz>] [--include-memory]   Write a shareable bundle (memory only when asked)",
  "  import <file.tar.gz> [--dry-run] [--force] [--acknowledge-risk]",
  "                                                 Add a shared setup to this one; nothing is replaced",
  "                                                 without --force, and dangerous skills need --acknowledge-risk",
].join("\n");

export interface SetupCommandDeps {
  write?: (text: string) => void;
}

function readFlag(args: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const i = args.indexOf(name);
    if (i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("-")) return args[i + 1];
  }
  return undefined;
}

function describeContents(m: SetupManifest): string[] {
  const c = m.contents;
  const line = (label: string, list: string[]) => `  ${label.padEnd(16)} ${list.length > 0 ? list.join(", ") : "none"}`;
  return [
    line("skills", c.skills),
    line("subagents", c.agents),
    line("MCP servers", c.mcpServers),
    line("cloud providers", c.providers),
    line("personas", c.personas),
    `  ${"memory".padEnd(16)} ${c.memory ? "included" : "not included"}`,
  ];
}

export async function setupCommand(args: string[], deps: SetupCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const [sub, ...rest] = args;
  if (!sub || sub === "-h" || sub === "--help") {
    write(`${HELP}\n`);
    return sub ? 0 : 2;
  }
  if (sub === "export") return runExport(rest, write);
  if (sub === "import") return runImport(rest, write);
  write(`unknown setup command: ${sub}\n\n${HELP}\n`);
  return 2;
}

async function runExport(rest: string[], write: (t: string) => void): Promise<number> {
  const stateDir = resolveStateDir();
  if (!existsSync(stateDir)) {
    write(`no data folder at ${stateDir}\n`);
    return 1;
  }
  const includeMemory = rest.includes("--include-memory");
  const out = readFlag(rest, "-o", "--out") ?? "atomic-agent-setup.tar.gz";
  const r = await exportSetup({
    stateDir: realpathSync(stateDir),
    outFile: out,
    starterSkills: await listStarterSkillNames(),
    includeMemory,
    appVersion: getAppVersion(),
  });
  write(`wrote ${r.file}\n${describeContents(r.manifest).join("\n")}\n`);
  if (r.manifest.redacted.length > 0) write(`taken out (the recipient fills these in): ${r.manifest.redacted.join(", ")}\n`);
  if (r.manifest.leftOut.length > 0) write(`left out: ${r.manifest.leftOut.join("; ")}\n`);
  if (includeMemory) {
    write("warning: the bundle holds your memory (notes and facts about you). Share it only with people you would tell those things.\n");
  }
  return 0;
}

function printImport(r: ImportSetupResult, write: (t: string) => void): void {
  write(`bundle from Atomic Agent ${r.manifest.appVersion ?? "(unknown version)"}, made ${r.manifest.createdAt}\n`);
  write(`${describeContents(r.manifest).join("\n")}\n`);
  for (const s of r.scan.findings) {
    write(`scan ${s.verdict}: ${s.item}\n`);
    for (const f of s.findings.slice(0, 5)) write(`    ${f.rule} ${f.file}:${f.line} ${f.excerpt}\n`);
  }
  if (r.items.length > 0) write("\n");
  for (const i of r.items) {
    write(`  [${i.status}] ${i.kind} ${i.source ?? ""}${i.reason ? ` (${i.reason})` : ""}\n`);
  }
}

async function runImport(rest: string[], write: (t: string) => void): Promise<number> {
  const file = rest.find((a) => !a.startsWith("-"));
  if (!file || !existsSync(file)) {
    write(`setup import needs a bundle file${file ? `: ${file} not found` : ""}\n`);
    return 2;
  }
  const config = getConfig();
  let result: ImportSetupResult;
  try {
    result = await importSetup({
      bundle: resolve(file),
      stateDir: config.paths.stateDir,
      userConfigFile: config.paths.userConfigFile,
      globalSkillsDir: config.paths.globalSkillsDir,
      dryRun: rest.includes("--dry-run"),
      force: rest.includes("--force"),
      acknowledgeRisk: rest.includes("--acknowledge-risk"),
      openMemoryTargets: () => {
        const sessionStore = new SessionStore({ dbFile: config.paths.sessionsDbFile });
        const taskStore = new TaskStore({ dbFile: config.paths.tasksDbFile });
        const memoryStore = new MemoryStore({ dbFile: config.paths.memoryDbFile, maxEntries: config.memory.notes.maxEntries });
        const profileStore = new ProfileStore({ dbFile: config.paths.memoryDbFile, maxEntries: config.memory.profile.maxEntries });
        return {
          targets: { sessionStore, taskStore, memoryStore, profileStore },
          close: () => {
            for (const s of [profileStore, memoryStore, taskStore, sessionStore]) {
              try { s.close(); } catch { /* best effort */ }
            }
          },
        };
      },
    });
  } catch (err) {
    if (err instanceof SetupBundleError) {
      write(`refused: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
  printImport(result, write);
  switch (result.status) {
    case "refused-dangerous":
      write("\nrefused: the scanner rated something dangerous. Read the findings; to install anyway, run again with --acknowledge-risk\n");
      return 1;
    case "refused-conflict":
      write("\nrefused: some names already exist here with different content. Nothing was written; --force replaces them\n");
      return 1;
    case "dry-run":
      write("\ndry run: nothing was written\n");
      break;
    case "nothing-to-do":
      write("\nnothing new to add\n");
      break;
    case "applied":
      write("\nimported\n");
      break;
  }
  if (result.disabledServers.length > 0) {
    write(`MCP servers arrive switched off; turn them on after a look: ${result.disabledServers.join(", ")}\n`);
  }
  if (result.mustFill.length > 0) write(`fill in these keys yourself (they were taken out): ${result.mustFill.join(", ")}\n`);
  return result.items.some((i) => i.status === "error") ? 1 : 0;
}
