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

import { isAnalyticsKilledByEnv } from "./read-analytics-kill-switch.js";
import type { AnalyticsSurface } from "./resolve-surface.js";

/** Override for the shared id file (the desktop passes it through). */
export const INSTALL_ID_FILE_ENV = "ATOMIC_AGENT_INSTALL_ID_FILE";

/** The terminal's default state dir name under the home directory. */
const TERMINAL_STATE_DIR_NAME = ".atomic-agent";

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
 *  2. Running as the desktop agent: adopt the TERMINAL's id from
 *     `~/.atomic-agent/analytics.json`, so a terminal user who opens the
 *     desktop first keeps the id their history is under — unless the
 *     terminal config (`~/.atomic-agent/config.json`) has
 *     `analytics.enabled: false`: a terminal opt-out is never linked.
 *  3. Else adopt this surface's own local id (its `analytics.json`).
 *  4. Else mint a fresh UUID.
 * The chosen id is written to the shared file.
 *
 * Nothing is read, minted, or written while analytics is disabled (by
 * config or `ATOMIC_AGENT_ANALYTICS=off`) — the local id is returned. The
 * default home path is never touched under the test runner (tests pass
 * an explicit file through `ATOMIC_AGENT_INSTALL_ID_FILE`). Never throws:
 * on an fs error the chosen id (or the local id, if it was minted) is
 * returned.
 */
export function resolveSharedInstallId(options: {
  localId: string;
  enabled: boolean;
  surface?: AnalyticsSurface;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Terminal state dir; defaults to `<home>/.atomic-agent`. */
  terminalStateDir?: string;
}): string {
  const env = options.env ?? process.env;
  if (!options.enabled || isAnalyticsKilledByEnv(env)) return options.localId;
  const hasOverride = Boolean(env[INSTALL_ID_FILE_ENV]?.trim());
  const underTest = env.VITEST !== undefined || env.NODE_ENV === "test";
  if (underTest && !hasOverride) return options.localId;

  const home = options.home ?? homedir();
  const filePath = resolveSharedInstallIdPath(env, home);
  try {
    const existing = readFileSync(filePath, "utf8").trim();
    if (isValidInstallId(existing)) return existing;
  } catch {
    // Missing / unreadable → adopt or mint below.
  }

  const terminalId =
    options.surface === "desktop"
      ? readTerminalInstallId(
          options.terminalStateDir ?? join(home, TERMINAL_STATE_DIR_NAME),
        )
      : undefined;
  const adopted =
    terminalId ??
    (isValidInstallId(options.localId) ? options.localId : undefined);
  const chosen = adopted ?? randomUUID();
  try {
    writeAtomically(filePath, `${chosen}\n`);
  } catch {
    return adopted ?? options.localId;
  }
  return chosen;
}

/**
 * The terminal's install id, or `undefined` when the terminal opted out
 * (`analytics.enabled === false` in its `config.json`), never ran, or
 * holds no valid id. An unreadable / unparseable config counts as the
 * default (enabled).
 */
function readTerminalInstallId(stateDir: string): string | undefined {
  if (terminalAnalyticsDisabled(stateDir)) return undefined;
  try {
    const parsed = JSON.parse(
      readFileSync(join(stateDir, "analytics.json"), "utf8"),
    ) as { installId?: unknown } | null;
    const id = parsed?.installId;
    return isValidInstallId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function terminalAnalyticsDisabled(stateDir: string): boolean {
  try {
    const parsed = JSON.parse(
      readFileSync(join(stateDir, "config.json"), "utf8"),
    ) as { analytics?: { enabled?: unknown } } | null;
    return parsed?.analytics?.enabled === false;
  } catch {
    return false;
  }
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
