import { existsSync, readdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type { DoctorContext, DoctorFinding } from "./doctor-checks.js";

/**
 * ATO-1233 — a leftover Atomic Core lock. Each Core version keeps
 * `<models>/core/versions/<v>/data/atomic-core/instance.lock`; a lock that
 * says "ready" but names another folder (copied or moved with the state
 * dir) or a process that is gone made `models update` fail with "Atomic
 * Core version, protocol or ownership changed". The agent now reconnects
 * past it; doctor still names it and, under --fix, moves it aside
 * (`instance.lock.stale-<time>`, never deleted), so the next start writes
 * a fresh one. A lock whose process is alive and whose folder matches is
 * the running Core's and is left alone.
 */
interface LockFile {
  state?: unknown;
  pid?: unknown;
  data_folder?: unknown;
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function modelsDir(ctx: DoctorContext): string {
  try {
    const tree = JSON.parse(readFileSync(ctx.configPath, "utf8")) as { localModels?: { managed?: { dataDirOverride?: unknown } } };
    const override = tree.localModels?.managed?.dataDirOverride;
    if (typeof override === "string" && override.length > 0) {
      return override.startsWith("~") ? join(process.env.HOME ?? "", override.slice(2)) : isAbsolute(override) ? override : resolve(ctx.stateDir, override);
    }
  } catch {
    /* no config or not JSON: the default folder */
  }
  return join(ctx.stateDir, "models");
}

export function checkCoreLocks(ctx: DoctorContext): DoctorFinding[] {
  const versions = join(modelsDir(ctx), "core", "versions");
  if (!existsSync(versions)) return [];
  const out: DoctorFinding[] = [];
  for (const version of readdirSync(versions)) {
    const dataDir = join(versions, version, "data");
    const lockPath = join(dataDir, "atomic-core", "instance.lock");
    if (!existsSync(lockPath)) continue;
    let lock: LockFile;
    try {
      lock = JSON.parse(readFileSync(lockPath, "utf8")) as LockFile;
    } catch {
      lock = {};
    }
    // Only a lock that still claims a running Core can get in the way; any other state is a stopped one.
    if (lock.state !== "ready") continue;
    const folder = typeof lock.data_folder === "string" ? lock.data_folder : "";
    const otherFolder = folder !== "" && canonical(folder) !== canonical(dataDir);
    const dead = typeof lock.pid === "number" && !ctx.pidAlive(lock.pid);
    if (!otherFolder && !dead) {
      out.push({ check: "core", status: "ok", message: `Atomic Core ${version}: its lock belongs to this folder` });
      continue;
    }
    const why = otherFolder ? `it names another folder (${folder})` : `its process (${String(lock.pid)}) is gone`;
    out.push({
      check: "core",
      status: "warn",
      message: `Atomic Core ${version} has a leftover lock: ${why}. It can make the engine install fail with "ownership changed".`,
      fix: {
        describe: `move ${lockPath} aside, so Atomic Core writes a fresh one at its next start`,
        file: () => renameSync(lockPath, `${lockPath}.stale-${ctx.now().toISOString().replace(/[:.]/g, "-")}`),
      },
    });
  }
  return out;
}
