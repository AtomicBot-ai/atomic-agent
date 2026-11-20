import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { USER_AGENT_DIR_NAME, parseAgentProfileFile } from "../agent-profiles/index.js";
import {
  ensureUserConfigFileSync,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";
import { parsePersonasConfig, type PersonaDefinition } from "../config/agent/persona-config.js";
import type { ImportItemResult } from "../import/import-report.js";
import { scanSkillDir, scanSkillFiles, type SkillScanFinding } from "../skills/index.js";
import { stripUnknownKeySources } from "./known-provider-env.js";
import { CONFIG_NAME, type SetupManifest } from "./setup-bundle-format.js";
import { stagedPath } from "./setup-bundle-read.js";

/**
 * ATO-1073: the parts of `setup import` the Atomic Agent importer does
 * not cover (subagent profiles, persona definitions), the security scan,
 * and the safety rewrite of the staged MCP servers and cloud providers. setup-import.ts runs
 * them in order.
 */
export type SetupItem = ImportItemResult<string>;

export interface ScanOutcome {
  /** `skills/<name>` or `agents/<file>` → findings, for every scanned item with any. */
  findings: Array<{ item: string; verdict: "caution" | "dangerous"; findings: SkillScanFinding[] }>;
  dangerous: boolean;
}

/** The skill scanner over every staged skill folder and subagent profile. */
export async function scanStagedBundle(staging: string, manifest: SetupManifest): Promise<ScanOutcome> {
  const out: ScanOutcome = { findings: [], dangerous: false };
  for (const name of stagedSkillNames(staging)) {
    const result = await scanSkillDir(join(staging, "skills", name));
    if (result.verdict === "ok") continue;
    out.findings.push({ item: `skills/${name}`, verdict: result.verdict, findings: result.findings });
    if (result.verdict === "dangerous") out.dangerous = true;
  }
  for (const file of manifest.files) {
    if (!file.path.startsWith("agents/")) continue;
    const path = stagedPath(staging, file.path);
    if (!existsSync(path)) continue;
    const result = scanSkillFiles([{ path: file.path, content: readFileSync(path, "utf8") }]);
    if (result.verdict === "ok") continue;
    out.findings.push({ item: file.path, verdict: result.verdict, findings: result.findings });
    if (result.verdict === "dangerous") out.dangerous = true;
  }
  return out;
}

export function stagedSkillNames(staging: string): string[] {
  const root = join(staging, "skills");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => existsSync(join(root, n, "SKILL.md"))).sort();
}

/**
 * What a blanked `args` value (the one after `--api-key`) reads as here:
 * the config parser refuses an empty argument, so an empty one would fail
 * the whole config write. The server arrives off, and `mustFill` names
 * the spot, so the person replaces this before turning it on.
 */
const MCP_ARG_PLACEHOLDER = "<fill in>";

/**
 * A server someone else set up runs a command on this computer: every
 * imported MCP server arrives switched off, with its own approval and
 * trust settings dropped, so it asks before each call once the person
 * fills in its keys and turns it on. Returns the names.
 */
export function disarmStagedMcpServers(staging: string): string[] {
  const path = join(staging, CONFIG_NAME);
  if (!existsSync(path)) return [];
  const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const mcp = config.mcp as { servers?: unknown } | undefined;
  if (!mcp || !Array.isArray(mcp.servers)) return [];
  const names: string[] = [];
  mcp.servers = mcp.servers.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") return raw;
    const server: Record<string, unknown> = { ...(raw as Record<string, unknown>), enabled: false };
    delete server.approval;
    delete server.trust;
    delete server.trustedReadOnlyTools;
    const transport = server.transport as Record<string, unknown> | undefined;
    if (transport && Array.isArray(transport.args)) {
      server.transport = {
        ...transport,
        args: transport.args.map((arg: unknown) => (arg === "" ? MCP_ARG_PLACEHOLDER : arg)),
      };
    }
    if (typeof server.name === "string") names.push(server.name);
    return server;
  });
  writeFileSync(path, JSON.stringify(config, null, 2));
  return names;
}

/**
 * Where a provider's key comes from is the recipient's to decide: a
 * bundle could carry an `apiKeyCommand` that runs on the first request,
 * or an `apiKeyEnvVar` naming one of this computer's keys next to a
 * `baseUrl` of the sender's choosing. The command is always dropped; a
 * key env var name stays only when it is the known variable of the
 * service the entry talks to (`GROQ_API_KEY` for api.groq.com, see
 * known-provider-env.ts). The dropped ones come back as config paths for
 * the "fill these in" list.
 */
export function disarmStagedProviders(staging: string): string[] {
  const path = join(staging, CONFIG_NAME);
  if (!existsSync(path)) return [];
  const config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const llm = config.llm as { providers?: unknown } | undefined;
  if (!llm || !Array.isArray(llm.providers)) return [];
  const dropped: string[] = [];
  llm.providers = llm.providers.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") return raw;
    const provider: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    const id = typeof provider.id === "string" ? provider.id : "?";
    for (const key of stripUnknownKeySources(provider)) dropped.push(`llm.providers[${id}].${key}`);
    return provider;
  });
  if (dropped.length > 0) writeFileSync(path, JSON.stringify(config, null, 2));
  return dropped;
}

/** Plan (and with `execute`, write) `<stateDir>/agents/*.md` from the bundle. */
export function importAgentProfiles(input: {
  staging: string;
  stateDir: string;
  manifest: SetupManifest;
  execute: boolean;
  force: boolean;
}): SetupItem[] {
  const items: SetupItem[] = [];
  const dir = join(input.stateDir, USER_AGENT_DIR_NAME);
  for (const file of input.manifest.files) {
    if (!file.path.startsWith("agents/")) continue;
    const name = file.path.slice("agents/".length);
    const content = readFileSync(stagedPath(input.staging, file.path), "utf8");
    const base: SetupItem = { kind: "agents", source: name, destination: `agents/${name}`, status: "migrated" };
    const parsed = parseAgentProfileFile(content, name.replace(/\.md$/, ""));
    if (!parsed.ok) {
      items.push({ ...base, status: "error", reason: `not a valid profile: ${parsed.error}` });
      continue;
    }
    const target = join(dir, name);
    const exists = existsSync(target);
    if (exists && readFileSync(target, "utf8") === content) {
      items.push({ ...base, status: "skipped", reason: "already here" });
      continue;
    }
    if (exists && !input.force) {
      items.push({ ...base, status: "conflict", reason: "a different profile with this name exists; use --force" });
      continue;
    }
    if (input.execute) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(target, content);
    }
    items.push({ ...base, ...(exists ? { reason: "overwritten" } : {}) });
  }
  return items;
}

/** Plan (and with `execute`, merge) `agent.personas.definitions`, added by name. */
export function importPersonas(input: {
  staging: string;
  userConfigFile: string;
  execute: boolean;
  force: boolean;
}): SetupItem[] {
  const path = join(input.staging, CONFIG_NAME);
  if (!existsSync(path)) return [];
  const raw = (JSON.parse(readFileSync(path, "utf8")) as { agent?: { personas?: unknown } }).agent?.personas;
  if (raw === undefined) return [];
  let incoming: Record<string, PersonaDefinition>;
  try {
    incoming = parsePersonasConfig(raw).definitions;
  } catch (err) {
    return [{ kind: "personas", status: "error", reason: `bundle personas: ${err instanceof Error ? err.message : String(err)}` }];
  }
  const file = structuredClone(ensureUserConfigFileSync(input.userConfigFile));
  const personas = file.agent.personas ?? { projects: {}, definitions: {} };
  const items: SetupItem[] = [];
  const definitions = { ...personas.definitions };
  let changed = false;
  for (const [name, def] of Object.entries(incoming)) {
    const base: SetupItem = { kind: "personas", source: name, destination: name, status: "migrated" };
    const have = definitions[name];
    if (have && JSON.stringify(have) === JSON.stringify(def)) {
      items.push({ ...base, status: "skipped", reason: "already here" });
      continue;
    }
    if (have && !input.force) {
      items.push({ ...base, status: "conflict", reason: "a different persona with this name exists; use --force" });
      continue;
    }
    definitions[name] = def;
    changed = true;
    items.push({ ...base, ...(have ? { reason: "overwritten" } : {}) });
  }
  if (input.execute && changed) {
    try {
      const next = parseUserConfigFile({ ...file, agent: { ...file.agent, personas: { ...personas, definitions } } });
      writeUserConfigFileSync(input.userConfigFile, next);
      resetConfigCache();
    } catch (err) {
      for (const item of items) {
        if (item.status === "migrated") {
          item.status = "error";
          item.reason = `config write failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
  }
  return items;
}
