import { symlink } from "node:fs/promises";
import type { ToolContext } from "../tool-registry.js";
import {
  buildOsFsLocateProjectTool,
  type OsFsLocateProjectDeps,
} from "./fs-locate-project.js";
import type { RecentSessionDir } from "./fs-locate-project-sources.js";

/**
 * Shared fixtures for the `os.fs.locate_project` test files
 * (`fs-locate-project-sources.test.ts` covers candidate collection,
 * `fs-locate-project.test.ts` covers verdicts and the tool interface).
 * Same precedent as `git/test-helpers.ts`.
 */

export function makeCtx(workingDir: string, signal?: AbortSignal): ToolContext {
  return {
    workingDir,
    sessionId: "test-session",
    stepIndex: 0,
    signal: signal ?? new AbortController().signal,
  };
}

export function makeTool(overrides: Partial<OsFsLocateProjectDeps> = {}) {
  return buildOsFsLocateProjectTool({
    listRecentSessions: () => [],
    projectRoots: [],
    ...overrides,
  });
}

export function session(workingDir: string, updatedAt = 1): RecentSessionDir {
  return { workingDir, updatedAt };
}

/** Windows without Developer Mode cannot create symlinks; skip there. */
export async function trySymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, "dir");
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return false;
    throw err;
  }
}
