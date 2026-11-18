import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AtomicDesktopImportTargets } from "../import/atomic-desktop/atomic-desktop-importer.js";
import {
  AtomicAgentImporter,
  type AtomicAgentOptionId,
} from "../import/atomic-agent/atomic-agent-importer.js";
import { readSetupBundle } from "./setup-bundle-read.js";
import type { SetupManifest } from "./setup-bundle-format.js";
import {
  disarmStagedMcpServers,
  disarmStagedProviders,
  importAgentProfiles,
  importPersonas,
  scanStagedBundle,
  type ScanOutcome,
  type SetupItem,
} from "./setup-import-parts.js";

/**
 * ATO-1073 — `atag setup import <file>`: install a setup someone shared
 * (Hermes' `profile import`), into this app's one state dir.
 *
 * Order, and why:
 *  1. Unpack into a private staging folder, refusing any path outside the
 *     allow-list (setup-bundle-read.ts). Nothing touches the state dir yet.
 *  2. Run the skill security scanner over every skill and subagent
 *     profile. A `dangerous` verdict stops the import unless the person
 *     passed `acknowledgeRisk`.
 *  3. Switch every staged MCP server off and drop its approval and trust
 *     settings: it was set up on someone else's computer. Drop every
 *     staged provider's key command and key env var names, so nothing
 *     runs and no local key is sent to a URL the sender chose.
 *  4. Preview everything. Skills, MCP servers, cloud providers and, when
 *     the bundle has it and stores are given, memory go through the
 *     existing Atomic Agent importer (the staging folder looks like
 *     another Atomic Agent data folder), so config sections are merged by
 *     name rather than replaced and no key is ever imported. Subagent
 *     profiles and persona definitions are planned here.
 *  5. A dry run stops after the preview. Otherwise a conflict (same name,
 *     different content) refuses the whole import unless `force`.
 *  6. Apply. Redacted values stay empty; `mustFill` lists them.
 */
export interface ImportSetupInput {
  bundle: string;
  stateDir: string;
  userConfigFile: string;
  globalSkillsDir: string;
  dryRun: boolean;
  force: boolean;
  acknowledgeRisk: boolean;
  /** Opened only when the bundle carries memory (`--include-memory` on export). */
  openMemoryTargets?: () => { targets: AtomicDesktopImportTargets; close(): void };
}

export type ImportSetupStatus = "dry-run" | "applied" | "refused-dangerous" | "refused-conflict" | "nothing-to-do";

export interface ImportSetupResult {
  status: ImportSetupStatus;
  manifest: SetupManifest;
  scan: ScanOutcome;
  items: SetupItem[];
  /** Config paths blanked on export or dropped on import; the person fills these in. */
  mustFill: string[];
  /** MCP servers that arrive switched off. */
  disabledServers: string[];
}

export async function importSetup(input: ImportSetupInput): Promise<ImportSetupResult> {
  const scratch = mkdtempSync(join(tmpdir(), "atag-setup-import-"));
  const staging = join(scratch, "bundle");
  let memory: { targets: AtomicDesktopImportTargets; close(): void } | null = null;
  try {
    const manifest = await readSetupBundle(input.bundle, staging);
    const scan = await scanStagedBundle(staging, manifest);
    const base = { manifest, scan, items: [] as SetupItem[], mustFill: manifest.redacted, disabledServers: [] as string[] };
    if (scan.dangerous && !input.acknowledgeRisk) return { ...base, status: "refused-dangerous" };
    const disabledServers = disarmStagedMcpServers(staging);
    const droppedKeySources = disarmStagedProviders(staging);
    const mustFill = [...new Set([...manifest.redacted, ...droppedKeySources])];

    const options: AtomicAgentOptionId[] = ["skills", "mcp", "providers"];
    if (manifest.contents.memory && input.openMemoryTargets) {
      memory = input.openMemoryTargets();
      options.push("memory");
    }
    const importer = new AtomicAgentImporter({
      sourceDir: staging,
      stateDir: input.stateDir,
      userConfigFile: input.userConfigFile,
      globalSkillsDir: input.globalSkillsDir,
      ...(memory ? { targets: memory.targets } : {}),
    });
    const plan = async (execute: boolean): Promise<SetupItem[]> => [
      ...(await importer.run({ options, execute, overwrite: input.force })).items.filter(isAboutTheBundle),
      ...importAgentProfiles({ staging, stateDir: input.stateDir, manifest, execute, force: input.force }),
      ...importPersonas({ staging, userConfigFile: input.userConfigFile, execute, force: input.force }),
    ];

    const preview = await plan(false);
    const result = { ...base, disabledServers, mustFill, items: preview };
    if (input.dryRun) return { ...result, status: "dry-run" };
    if (preview.some((i) => i.status === "conflict")) return { ...result, status: "refused-conflict" };
    if (!preview.some((i) => i.status === "migrated")) return { ...result, status: "nothing-to-do" };
    return { ...result, items: await plan(true), status: "applied" };
  } finally {
    memory?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The importer reports an empty domain as a `skipped` row naming the
 * source path ("no MCP servers in /tmp/…/config.json"); for a bundle that
 * row is noise and the path is a temp folder, so it is left out.
 */
function isAboutTheBundle(item: SetupItem): boolean {
  return !(item.status === "skipped" && item.source === undefined);
}
