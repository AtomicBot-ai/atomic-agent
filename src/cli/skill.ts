import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ensureUserConfigFileSync,
  getConfig,
  resetConfigCache,
  writeUserConfigFileSync,
  type UserConfigFile,
} from "../config/index.js";
import {
  installSkill,
  SkillInstallError,
  uninstallSkill,
} from "../skills/skill-installer.js";
import { loadSkills } from "../skills/skill-loader.js";

const HELP =
  [
    "atomic-agent skill — manage installed skills",
    "",
    "Subcommands:",
    "  install <path> [--force]   Install a skill from a local directory into the global skills dir",
    "  uninstall <name>           Remove an installed global skill",
    "  list                       List installed skills (project + global) with enabled/disabled state",
    "  show <name>                Print SKILL.md for an installed skill",
    "  enable <name>              Re-enable a previously disabled skill (mutates config.json)",
    "  disable <name>             Hide a skill from the registry without removing files (mutates config.json)",
  ].join("\n") + "\n";

export async function skillCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === "-h" || sub === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    switch (sub) {
      case "install":
        return await handleInstall(args.slice(1));
      case "uninstall":
        return await handleUninstall(args.slice(1));
      case "list":
        return await handleList();
      case "show":
        return await handleShow(args.slice(1));
      case "enable":
        return await handleEnable(args.slice(1));
      case "disable":
        return await handleDisable(args.slice(1));
      default:
        process.stderr.write(`unknown subcommand: ${sub}\n`);
        process.stderr.write(HELP);
        return 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`skill ${sub} failed: ${message}\n`);
    return 1;
  }
}

async function handleInstall(args: string[]): Promise<number> {
  const source = args.find((a) => !a.startsWith("--"));
  if (!source) {
    process.stderr.write("usage: atomic-agent skill install <path> [--force]\n");
    return 1;
  }
  const force = args.includes("--force");
  const config = getConfig();
  try {
    const result = await installSkill({
      sourceDir: resolve(source),
      targetRoot: config.paths.globalSkillsDir,
      force,
    });
    process.stdout.write(
      `installed ${result.manifest.name} (v${result.manifest.version}) at ${result.installedAt}\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof SkillInstallError && err.code === "already_installed") {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

async function handleUninstall(args: string[]): Promise<number> {
  const name = args[0];
  if (!name) {
    process.stderr.write("usage: atomic-agent skill uninstall <name>\n");
    return 1;
  }
  const config = getConfig();
  const result = await uninstallSkill(config.paths.globalSkillsDir, name);
  if (result.removed) {
    process.stdout.write(`removed ${result.path}\n`);
    return 0;
  }
  process.stderr.write(`skill not installed globally: ${name}\n`);
  return 2;
}

async function handleList(): Promise<number> {
  const config = getConfig();
  const projectDir = resolve(process.cwd(), config.paths.projectSkillsDirName);
  const { skills, errors } = await loadSkills({
    globalDir: config.paths.globalSkillsDir,
    projectDir,
  });
  const disabled = new Set(config.skills.disabled);
  if (skills.length === 0) {
    process.stdout.write("(no skills installed)\n");
  } else {
    for (const s of skills) {
      const state = disabled.has(s.manifest.name) ? "disabled" : "enabled";
      process.stdout.write(
        `${s.manifest.name}\tv${s.manifest.version}\t[${s.source}]\t${state}\t${s.manifest.description}\n`,
      );
    }
  }
  // Surface entries that are in the disable list but no longer installed —
  // useful when a config.json is shared across machines and a skill was
  // uninstalled on this one.
  const installedNames = new Set(skills.map((s) => s.manifest.name));
  for (const name of disabled) {
    if (installedNames.has(name)) continue;
    process.stdout.write(`${name}\t-\t[missing]\tdisabled\t(not installed)\n`);
  }
  for (const e of errors) {
    process.stderr.write(`WARN: ${e.path}: ${e.error}\n`);
  }
  return 0;
}

async function handleShow(args: string[]): Promise<number> {
  const name = args[0];
  if (!name) {
    process.stderr.write("usage: atomic-agent skill show <name>\n");
    return 1;
  }
  const config = getConfig();
  const projectDir = resolve(process.cwd(), config.paths.projectSkillsDirName);
  const { skills } = await loadSkills({
    globalDir: config.paths.globalSkillsDir,
    projectDir,
  });
  const record = skills.find((s) => s.manifest.name === name);
  if (!record) {
    process.stderr.write(`skill not installed: ${name}\n`);
    return 2;
  }
  process.stdout.write(`# path: ${record.manifestPath}\n`);
  process.stdout.write(`# source: ${record.source}\n\n`);
  const content = await readFile(record.manifestPath, "utf8");
  process.stdout.write(content);
  if (!content.endsWith("\n")) process.stdout.write("\n");
  return 0;
}

async function handleEnable(args: string[]): Promise<number> {
  const name = args[0];
  if (!name) {
    process.stderr.write("usage: atomic-agent skill enable <name>\n");
    return 1;
  }
  const result = mutateDisabledList((current) => {
    if (!current.includes(name)) return null;
    return current.filter((n) => n !== name);
  });
  if (!result) {
    process.stdout.write(`already enabled: ${name}\n`);
    return 0;
  }
  process.stdout.write(`enabled: ${name}\n`);
  return 0;
}

async function handleDisable(args: string[]): Promise<number> {
  const name = args[0];
  if (!name) {
    process.stderr.write("usage: atomic-agent skill disable <name>\n");
    return 1;
  }
  const result = mutateDisabledList((current) => {
    if (current.includes(name)) return null;
    return [...current, name].sort();
  });
  if (!result) {
    process.stdout.write(`already disabled: ${name}\n`);
    return 0;
  }
  // Warn if the name doesn't correspond to an installed skill yet —
  // we still persist the entry (users may share config.json across
  // machines), but make the disconnect visible.
  const config = getConfig();
  const projectDir = resolve(process.cwd(), config.paths.projectSkillsDirName);
  const { skills } = await loadSkills({
    globalDir: config.paths.globalSkillsDir,
    projectDir,
  });
  if (!skills.some((s) => s.manifest.name === name)) {
    process.stderr.write(
      `WARN: ${name} is not currently installed; entry persisted in config\n`,
    );
  }
  process.stdout.write(`disabled: ${name}\n`);
  return 0;
}

/**
 * Read `config.json`, run the supplied mutator on the current
 * `skills.disabled` array, and write the updated file. Returns the
 * new file when mutation occurred, `null` when the mutator returned
 * `null` to signal "no change". Triggers `ensureUserConfigFileSync`
 * first so a fresh default file is created when missing.
 */
function mutateDisabledList(
  mutate: (current: string[]) => string[] | null,
): UserConfigFile | null {
  const config = getConfig();
  const path = config.paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const next = mutate([...file.skills.disabled]);
  if (next === null) return null;
  const updated: UserConfigFile = {
    ...file,
    skills: { disabled: next },
  };
  writeUserConfigFileSync(path, updated);
  // Drop the cached AtomicAgentConfig so any subsequent `getConfig()`
  // call in the same process (e.g. tests, chained CLI invocations,
  // long-running TUI orchestrators) re-reads the freshly-written file.
  resetConfigCache();
  return updated;
}
