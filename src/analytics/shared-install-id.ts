import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Override for the shared id file (the desktop passes it through). */
export const INSTALL_ID_FILE_ENV = "ATOMIC_AGENT_INSTALL_ID_FILE";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical UUID string. */
export function isValidInstallId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Path of the machine-wide install id file. */
export function resolveSharedInstallIdPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const override = env[INSTALL_ID_FILE_ENV]?.trim();
  return override ? override : join(home, ".atomic-agent-install-id");
}

/**
 * Resolve the one install id shared by every surface on this machine
 * (terminal and desktop), so PostHog sees one person, not two.
 *
 *  1. The shared file exists and holds a valid UUID → use it.
 *  2. Else adopt the surface's local id (from `analytics.json`), so an
 *     existing terminal user keeps the id their history is under, and
 *     write it to the shared file.
 *  3. Else (no valid local id either) mint a fresh UUID and write it.
 *
 * The shared file is only touched while analytics is enabled, and never
 * at the default home path under the test runner (tests pass an explicit
 * file through `ATOMIC_AGENT_INSTALL_ID_FILE`). Never throws: on any fs
 * error the local id is returned.
 */
export function resolveSharedInstallId(options: {
  localId: string;
  enabled: boolean;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): string {
  const env = options.env ?? process.env;
  const fallback = isValidInstallId(options.localId)
    ? options.localId
    : randomUUID();
  if (!options.enabled) return options.localId;
  const hasOverride = Boolean(env[INSTALL_ID_FILE_ENV]?.trim());
  const underTest = env.VITEST !== undefined || env.NODE_ENV === "test";
  if (underTest && !hasOverride) return options.localId;

  const filePath = resolveSharedInstallIdPath(env, options.home);
  try {
    const existing = readFileSync(filePath, "utf8").trim();
    if (isValidInstallId(existing)) return existing;
  } catch {
    // Missing / unreadable → adopt or mint below.
  }
  try {
    writeAtomically(filePath, `${fallback}\n`);
  } catch {
    return options.localId;
  }
  return fallback;
}

function writeAtomically(filePath: string, contents: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, filePath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
