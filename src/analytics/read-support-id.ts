import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  isValidInstallId,
  resolveSharedInstallIdPath,
} from "./resolve-shared-install-id.js";

/**
 * The id support asks for to find a person in PostHog and Sentry
 * (ATO-1466): the machine-wide install id when the shared file holds
 * one, else this state dir's own `analytics.json` id. Read-only: it
 * never mints or writes an id, so `atag id`, `atag doctor` and a bug
 * report can show it with analytics off as well (the operator copies it
 * by hand; nothing is sent). `null` when neither file holds a valid id.
 */
export function readSupportId(options: {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): string | null {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const shared = readTrimmed(resolveSharedInstallIdPath(env, home));
  if (isValidInstallId(shared)) return shared;
  const local = readTrimmed(join(options.stateDir, "analytics.json"));
  if (local === undefined) return null;
  try {
    const parsed = JSON.parse(local) as { installId?: unknown };
    return isValidInstallId(parsed.installId) ? parsed.installId : null;
  } catch {
    return null;
  }
}

function readTrimmed(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}
