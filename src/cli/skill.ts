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
import {
  browseHub,
  GithubSkillClient,
  installSkillFromHub,
  looksLikeHubIdentifier,
  parseTapRepo,
  searchHub,
  summarizeScan,
  type SkillTap,
} from "../skills/hub/index.js";
import {
  browseClawHub,
  ClawHubClient,
  installSkillRouted,
  listStarterSkillNames,
  looksLikeClawHubIdentifier,
  searchClawHub,
  type HubSkillEntry,
} from "../skills/index.js";

const HELP =
  [
    "atomic-agent skill — manage installed skills",
    "",
    "Subcommands:",
    "  install <path|owner/repo[/path]|@owner/slug> [--force] [--acknowledge-risk]",
    "                             Install a skill from a local directory, the GitHub skill hub, or ClawHub (@owner/slug)",
    "  uninstall <name>           Remove an installed global skill",
    "  list                       List installed skills (project + global) with enabled/disabled state",
    "  show <name>                Print SKILL.md for an installed skill",
    "  enable <name>              Re-enable a previously disabled skill (mutates config.json)",
    "  disable <name>             Hide a skill from the registry without removing files (mutates config.json)",
    "  browse [--source owner/repo]   Browse installable skills (ClawHub + configured GitHub taps)",
    "  search <query>             Search ClawHub + the configured GitHub taps",
    "  tap list|add <owner/repo>|remove <owner/repo>   Manage hub taps (mutates config.json)",
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
      case "browse":
        return await handleBrowse(args.slice(1));
      case "search":
        return await handleSearch(args.slice(1));
      case "tap":
        return await handleTap(args.slice(1));
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
    process.stderr.write(
      "usage: atomic-agent skill install <path|owner/repo[/path]> [--force] [--acknowledge-risk]\n",
    );
    return 1;
  }
  const force = args.includes("--force");
  const acknowledgeRisk = args.includes("--acknowledge-risk");
  const config = getConfig();
  // A ClawHub identifier (`@owner/slug`) routes through the registry
  // installer; a GitHub identifier (`owner/repo[/path]`) routes through
  // the tap installer; anything else is a local directory path.
  if (looksLikeClawHubIdentifier(source)) {
    return await handleClawHubInstall(
      source,
      force,
      acknowledgeRisk,
      config.paths.globalSkillsDir,
      config.skills.clawhub.apiBase,
    );
  }
  if (looksLikeHubIdentifier(source)) {
    return await handleHubInstall(
      source,
      force,
      acknowledgeRisk,
      config.paths.globalSkillsDir,
    );
  }
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

async function handleHubInstall(
  identifier: string,
  force: boolean,
  acknowledgeRisk: boolean,
  targetRoot: string,
): Promise<number> {
  try {
    const result = await installSkillFromHub({
      identifier,
      targetRoot,
      force,
      acknowledgeRisk,
    });
    process.stdout.write(
      `installed ${result.manifest.name} (v${result.manifest.version}) from ${identifier} — ${summarizeScan(result.scan)}\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof SkillInstallError && err.code === "already_installed") {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    return 2;
  }
}

async function handleClawHubInstall(
  identifier: string,
  force: boolean,
  acknowledgeRisk: boolean,
  targetRoot: string,
  apiBase: string,
): Promise<number> {
  try {
    const result = await installSkillRouted({
      identifier,
      source: "clawhub",
      clawHubClient: new ClawHubClient({ apiBase }),
      targetRoot,
      force,
      acknowledgeRisk,
    });
    process.stdout.write(
      `installed ${result.manifest.name} (v${result.manifest.version}) from ${identifier} — ${summarizeScan(result.scan)}\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof SkillInstallError && err.code === "already_installed") {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    return 2;
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
  if (!result.removed) {
    process.stderr.write(`skill not installed globally: ${name}\n`);
    return 2;
  }
  // Drop any stale disable entry so config.json does not accumulate
  // dangling names for skills that no longer exist on disk.
  mutateDisabledList((current) =>
    current.includes(name) ? current.filter((n) => n !== name) : null,
  );
  process.stdout.write(`removed ${result.path}\n`);
  const starters = await listStarterSkillNames();
  if (starters.has(name)) {
    process.stdout.write(
      `note: "${name}" is a bundled starter — it will be re-created on the next start; use "skill disable ${name}" to hide it permanently\n`,
    );
  }
  return 0;
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

function configuredTaps(restrictTo?: string): SkillTap[] {
  const config = getConfig();
  const repos = restrictTo ? [restrictTo] : config.skills.taps;
  return repos.map((repo) => ({ repo, path: "" }));
}

async function handleBrowse(args: string[]): Promise<number> {
  const sourceIdx = args.indexOf("--source");
  const source =
    sourceIdx !== -1 ? args[sourceIdx + 1]?.trim() : undefined;
  if (sourceIdx !== -1 && !source) {
    process.stderr.write("usage: atomic-agent skill browse [--source owner/repo]\n");
    return 1;
  }
  // ClawHub is the primary catalog; `--source owner/repo` narrows to a
  // single GitHub tap and skips ClawHub (the operator asked for a repo).
  const clawEntries = source ? [] : await browseClawHubSafe(null);
  const client = new GithubSkillClient();
  const { entries, errors } = await browseHub(client, configuredTaps(source));
  return printHubEntries([...clawEntries, ...entries], errors);
}

async function handleSearch(args: string[]): Promise<number> {
  const query = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (query.length === 0) {
    process.stderr.write("usage: atomic-agent skill search <query>\n");
    return 1;
  }
  const clawEntries = await browseClawHubSafe(query);
  const client = new GithubSkillClient();
  const { entries, errors } = await searchHub(client, configuredTaps(), query);
  return printHubEntries([...clawEntries, ...entries], errors);
}

/**
 * ClawHub browse/search for the CLI. Returns an empty list (no API call)
 * when ClawHub is disabled, and prints a non-fatal warning on failure so
 * the GitHub-tap results still render.
 */
async function browseClawHubSafe(
  query: string | null,
): Promise<HubSkillEntry[]> {
  const cfg = getConfig().skills.clawhub;
  if (!cfg.enabled) return [];
  const client = new ClawHubClient({ apiBase: cfg.apiBase });
  try {
    if (query && query.length > 0) {
      return await searchClawHub(client, query, {
        limit: cfg.browseLimit,
        nonSuspiciousOnly: cfg.nonSuspiciousOnly,
      });
    }
    return await browseClawHub(client, {
      limit: cfg.browseLimit,
      sort: "recommended",
      nonSuspiciousOnly: cfg.nonSuspiciousOnly,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`WARN: clawhub: ${message}\n`);
    return [];
  }
}

function printHubEntries(
  entries: ReadonlyArray<{
    identifier: string;
    version: string;
    description: string;
    source?: "github" | "clawhub";
    downloads?: number;
  }>,
  errors: ReadonlyArray<{ repo: string; error: string }>,
): number {
  if (entries.length === 0) {
    process.stdout.write("(no skills found)\n");
  } else {
    for (const e of entries) {
      const badge = e.source === "clawhub" ? "[claw]" : "[gh]";
      // ClawHub tracks downloads; GitHub taps do not (dash keeps columns
      // aligned). Raw integer so the output stays grep/awk-friendly.
      const downloads = e.downloads === undefined ? "-" : `↓${e.downloads}`;
      process.stdout.write(
        `${badge}\t${e.identifier}\t${downloads}\t${e.description}\n`,
      );
    }
  }
  for (const e of errors) {
    process.stderr.write(`WARN: ${e.repo}: ${e.error}\n`);
  }
  return 0;
}

async function handleTap(args: string[]): Promise<number> {
  const verb = (args[0] ?? "").toLowerCase();
  if (verb === "list" || verb === "") {
    const config = getConfig();
    if (config.skills.taps.length === 0) {
      process.stdout.write("(no taps configured)\n");
    } else {
      for (const repo of config.skills.taps) process.stdout.write(`${repo}\n`);
    }
    return 0;
  }
  if (verb === "add" || verb === "remove") {
    const repo = args[1]?.trim();
    if (!repo) {
      process.stderr.write(`usage: atomic-agent skill tap ${verb} <owner/repo>\n`);
      return 1;
    }
    try {
      parseTapRepo(repo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${message}\n`);
      return 1;
    }
    const result = mutateTapsList((current) => {
      if (verb === "add") {
        if (current.includes(repo)) return null;
        return [...current, repo];
      }
      if (!current.includes(repo)) return null;
      return current.filter((r) => r !== repo);
    });
    if (!result) {
      process.stdout.write(
        verb === "add" ? `tap already present: ${repo}\n` : `tap not present: ${repo}\n`,
      );
      return 0;
    }
    process.stdout.write(verb === "add" ? `tap added: ${repo}\n` : `tap removed: ${repo}\n`);
    return 0;
  }
  process.stderr.write(
    "usage: atomic-agent skill tap list | add <owner/repo> | remove <owner/repo>\n",
  );
  return 1;
}

/**
 * Read `config.json`, run the supplied mutator on the current
 * `skills.taps` array, and write the updated file. Same contract as
 * `mutateDisabledList`.
 */
function mutateTapsList(
  mutate: (current: string[]) => string[] | null,
): UserConfigFile | null {
  const config = getConfig();
  const path = config.paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const next = mutate([...file.skills.taps]);
  if (next === null) return null;
  const updated: UserConfigFile = {
    ...file,
    skills: { ...file.skills, taps: next },
  };
  writeUserConfigFileSync(path, updated);
  resetConfigCache();
  return updated;
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
    skills: { ...file.skills, disabled: next },
  };
  writeUserConfigFileSync(path, updated);
  // Drop the cached AtomicAgentConfig so any subsequent `getConfig()`
  // call in the same process (e.g. tests, chained CLI invocations,
  // long-running TUI orchestrators) re-reads the freshly-written file.
  resetConfigCache();
  return updated;
}
