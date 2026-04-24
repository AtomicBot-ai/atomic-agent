import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { resolveVersionFilePath } from "./backend-paths.js";

export interface BackendVersionInfo {
  tag: string;
  downloadedAt: string;
}

export function readBackendVersion(dataDir: string): BackendVersionInfo | null {
  try {
    const raw = readFileSync(resolveVersionFilePath(dataDir), "utf-8");
    return JSON.parse(raw) as BackendVersionInfo;
  } catch {
    return null;
  }
}

export function writeBackendVersion(dataDir: string, info: BackendVersionInfo): void {
  const p = resolveVersionFilePath(dataDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(info, null, 2) + "\n");
}
