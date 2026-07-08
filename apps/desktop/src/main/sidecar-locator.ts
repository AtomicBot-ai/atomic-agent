import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { buildSidecarChildEnv, resolveAgentNodeBinary } from "./resolve-agent-node.js";

/** Repo root: atomic-agent/ */
export function resolveRepoRoot(): string {
  if (!app.isPackaged) {
    // out/main/index.js → apps/desktop/out/main → four levels up to repo root.
    return join(__dirname, "../../../..");
  }
  return join(app.getAppPath(), "..", "..");
}

export interface SidecarSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Dev: spawn sidecar with the repo's Node 25+ binary (via Volta or ATOMIC_AGENT_NODE).
 * Prod: SEA sidecar binary under extraResources (stub until packaging lands).
 */
export function resolveSidecarSpawnSpec(): SidecarSpawnSpec {
  const repoRoot = resolveRepoRoot();
  const sidecarEntry = join(repoRoot, "src", "sidecar", "main.ts");
  const distEntry = join(repoRoot, "dist", "sidecar", "main.js");

  if (!app.isPackaged) {
    const nodeBin = resolveAgentNodeBinary(repoRoot);

    if (existsSync(sidecarEntry)) {
      return {
        command: nodeBin,
        args: ["--import", "tsx", sidecarEntry],
        cwd: repoRoot,
        env: buildSidecarChildEnv(),
      };
    }
    if (existsSync(distEntry)) {
      return {
        command: nodeBin,
        args: [distEntry],
        cwd: repoRoot,
        env: buildSidecarChildEnv(),
      };
    }
    throw new Error(
      `sidecar entry not found. Run npm install at repo root and ensure ${sidecarEntry} exists.`,
    );
  }

  const resourcesPath = process.resourcesPath;
  const platform = process.platform;
  const sidecarName =
    platform === "win32"
      ? "atomic-agent-sidecar.exe"
      : "atomic-agent-sidecar";
  const packagedBinary = join(resourcesPath, "sidecar", sidecarName);

  if (!existsSync(packagedBinary)) {
    throw new Error(
      `packaged sidecar binary not found at ${packagedBinary}. Build with bundle:tauri-sidecar first.`,
    );
  }

  return {
    command: packagedBinary,
    args: [],
    cwd: app.getPath("userData"),
    env: buildSidecarChildEnv(),
  };
}
